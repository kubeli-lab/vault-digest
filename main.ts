import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { simpleGit, SimpleGit, SimpleGitOptions, StatusResult, DiffResult } from 'simple-git';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeDiff, digestSummary, digestDetails, fitSubject, fitBody, MAX_DIGEST_LINES, NoteDigest } from './digest';

// Message of the stash created around a pull; identifies our own entries only.
const SYNC_STASH_MESSAGE = 'vault-digest autostash';

let simpleGitOptions: Partial<SimpleGitOptions>;
let git: SimpleGit;

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';


interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	branch: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	branch: 'main',
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
}


export default class GHSyncPlugin extends Plugin {

	settings: GHSyncSettings;

	// True while the git mergetool window is open: syncs are held meanwhile.
	private mergetoolOpen = false;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity === 'WARNING' || severity === 'ERROR';
			case 'ALL':
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (!this.shouldShowNotice(severity)) {
			return;
		}

		const text = message instanceof Error ? message.message : String(message);
		new Notice(text, timeout);
	}

	private formatDiffFiles(diff: DiffResult | undefined): string[] {
		if (!diff) {
			return [];
		}
		return diff.files.map((f) => {
			const stats = 'insertions' in f ? " (+" + f.insertions + " -" + f.deletions + ")" : " (binary)";
			return f.file + stats;
		});
	}

	private showSyncSuccessNotice(pushed?: DiffResult, pulled?: DiffResult): void {
		if (!this.settings.showSyncSuccessNotice) {
			return;
		}

		const maxListed = 5;
		const lines: string[] = ['github sync successful'];
		const section = (arrow: string, label: string, files: string[]) => {
			if (files.length === 0) {
				return;
			}
			lines.push(arrow + " " + files.length + " " + label);
			for (const f of files.slice(0, maxListed)) {
				lines.push("\t" + f);
			}
			if (files.length > maxListed) {
				lines.push("\t... and " + (files.length - maxListed) + " more");
			}
		};
		section("\u2191", "pushed", this.formatDiffFiles(pushed));
		section("\u2193", "pulled", this.formatDiffFiles(pulled));

		this.showNotice(lines.join("\n"), 'INFO', lines.length > 1 ? 8000 : undefined);
	}

	// One extra git call, markdown only, skipped for big diffs: keeps sync fast.
	// Any failure falls back to the plain message.
	private async computeDigest(summary: DiffResult | undefined): Promise<NoteDigest | undefined> {
		if (!summary || summary.insertions + summary.deletions > MAX_DIGEST_LINES) {
			return undefined;
		}
		try {
			const diff = await git.raw([
				'-c', 'core.quotepath=false',
				'diff', '--cached', '-U0', '--no-color', '--no-ext-diff',
				'--src-prefix=a/', '--dst-prefix=b/',
				'--', '*.md',
			]);
			return analyzeDiff(diff);
		} catch {
			return undefined;
		}
	}

	private buildCommitMessage(status: StatusResult, diff: DiffResult | undefined, digest: NoteDigest | undefined, hostname: string): string[] {
		const entries: string[] = [];
		const counts: string[] = [];

		const stats = new Map<string, string>();
		for (const f of diff?.files ?? []) {
			stats.set(f.file, 'insertions' in f ? " (+" + f.insertions + " -" + f.deletions + ")" : " (binary)");
		}

		const add = (label: string, code: string, files: string[]) => {
			if (files.length === 0) {
				return;
			}
			counts.push(files.length + " " + label);
			for (const f of files) {
				entries.push(code + " " + f + (stats.get(f) ?? ""));
			}
		};

		const renamed = status.renamed.map((r) => r.from + " -> " + r.to);
		const created = Array.from(new Set([...status.created, ...status.not_added]));
		add("added", "A", created);
		add("modified", "M", status.modified);
		add("deleted", "D", status.deleted);
		add("renamed", "R", renamed);

		const total = diff ? " +" + diff.insertions + " -" + diff.deletions : "";
		const digestParts = digest ? digestSummary(digest) : [];
		const subjectParts = counts.length > 0 ? [counts.join(", ") + total, ...digestParts] : digestParts;
		const subject = fitSubject("vault: sync from " + hostname, subjectParts);

		// Body: digest details first, then the file list, within a size budget.
		const lines: string[] = digest ? digestDetails(digest) : [];
		if (lines.length > 0 && entries.length > 0) {
			lines.push("");
		}
		lines.push(...entries);
		const body = fitBody(lines);

		return body.length > 0 ? [subject, body.join("\n")] : [subject];
	}

	// Drops stash entries left by an earlier sync whose conflicts are now resolved.
	// Kept if conflict markers are still staged: the stash is then the only clean copy.
	private async dropResolvedSyncStash(): Promise<void> {
		try {
			const list = await git.raw(['stash', 'list', '--format=%gd %s']);
			const refs = list.split("\n")
				.filter((l) => l.includes(SYNC_STASH_MESSAGE))
				.map((l) => l.split(" ")[0]);
			if (refs.length === 0) {
				return;
			}
			const withMarkers = await git.raw(['diff', '--cached', '-U0', '--no-color', '--name-only', '-G', '^<<<<<<< ']);
			if (withMarkers.trim() !== "") {
				this.showNotice("Vault Digest: conflict markers are still present, your stash is kept (git stash list).", 'WARNING', 10000);
				return;
			}
			for (const ref of refs.reverse()) {
				await git.raw(['stash', 'drop', ref]);
			}
		} catch {
			// Best effort: a leftover stash is harmless.
		}
	}

	// Main branch to sync with (setting, default "main"). The name is passed to git
	// as an argument, so only plain ref characters are accepted.
	private get branch(): string {
		return (this.settings.branch || 'main').trim();
	}

	private isValidBranchName(name: string): boolean {
		return /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
	}

	// Absolute path of the vault folder (desktop only: the vault is on disk).
	private vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		throw new Error("Vault Digest needs a vault stored on disk (desktop only).");
	}

	private initGit(): void {
		simpleGitOptions = {
		    baseDir: this.vaultPath(),
		    binary: this.settings.gitLocation + "git",
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		    // Never guess the author from the machine user and hostname: git must
		    // use user.name and user.email from its configuration, or fail.
		    config: ['user.useConfigOnly=true'],
		};
		git = simpleGit(simpleGitOptions);
	}

	// Runs the git binary directly (no tty, no prompt). The PATH is completed
	// because Obsidian launched from the Dock does not inherit the shell PATH,
	// and merge tools such as `code` live in /usr/local/bin or /opt/homebrew/bin.
	private runGit(args: string[]): Promise<string> {
		const cwd = this.vaultPath();
		const extra = os.platform() === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
		const env = {
			...process.env,
			PATH: [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter),
			GIT_TERMINAL_PROMPT: "0",
		};
		return new Promise((resolve, reject) => {
			execFile(this.settings.gitLocation + "git", args, { cwd, env, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
				(err, stdout, stderr) => {
					if (err) {
						reject(new Error(stderr || err.message));
					} else {
						resolve(stdout);
					}
				});
		});
	}

	// Opens the merge tool configured in git (merge.tool); opendiff on macOS if none.
	async ResolveConflicts(): Promise<void> {
		// Latch set synchronously, before any await, so two clicks cannot both pass.
		if (this.mergetoolOpen) {
			return;
		}
		if (this.syncing) {
			this.showNotice("Vault Digest: a sync is running, try again when it is done.", 'INFO');
			return;
		}
		this.mergetoolOpen = true;

		let resumeSync: boolean;
		try {
			this.initGit();

			const status = await git.status().catch(() => undefined);
			if (!status) {
				this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
				return;
			}
			if (status.conflicted.length === 0) {
				this.showNotice("No conflicts to resolve.", 'INFO');
				return;
			}

			const configured = (await git.raw(['config', '--get', 'merge.tool']).catch(() => "")).trim();
			const tool = configured || (os.platform() === "darwin" ? "opendiff" : "");
			if (!tool) {
				this.showNotice("No git merge tool configured. Run: git config --global merge.tool <tool> (for example vscode, meld or kdiff3). The conflicted files are opened so you can edit them.", 'WARNING', 15000);
				for (const c of status.conflicted) {
					void this.app.workspace.openLinkText("", c, true);
				}
				return;
			}

			// Modify/delete conflicts need a choice (Keep / Delete buttons): the merge
			// tool would ask for it on a terminal, which does not exist here.
			const needDecision = new Set(this.modifyDeleteFiles(status));
			const forTool = status.conflicted.filter((c) => !needDecision.has(c));
			if (forTool.length === 0) {
				await this.reportConflicts(status.conflicted, undefined, false);
				return;
			}

			this.showNotice("Opening git mergetool (" + tool + ")...", 'INFO');
			try {
				await this.runGit([
					'-c', 'mergetool.keepBackup=false',
					'mergetool', '--no-prompt',
					...(configured ? [] : ['--tool=' + tool]),
					'--', ...forTool,
				]);
			} catch {
				// Non-zero exit: the tool was closed without resolving every file.
			}

			const after = await git.status().catch(() => undefined);
			const unresolved = after ? await this.findUnresolvedConflicts(after) : [];
			if (unresolved.length > 0) {
				await this.reportConflicts(unresolved, undefined, false);
				return;
			}
			this.showNotice("Conflicts resolved, syncing...", 'INFO');
			resumeSync = true;
		} finally {
			this.mergetoolOpen = false;
		}

		// Non-interactive: if this sync hits a new conflict it only reports it, so a
		// user action starts the merge tool at most once.
		if (resumeSync) {
			await this.SyncNotes(false);
		}
	}

	// Push; if the remote moved since our fetch (another device pushed meanwhile),
	// rebase onto it and push again, up to 5 attempts with a short random pause so
	// devices syncing at the same moment do not retry in lockstep.
	// Returns false when it stopped.
	private async pushWithRetry(interactive: boolean): Promise<boolean> {
		const maxAttempts = 5;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await git.push('origin', this.branch, ['-u']);
				return true;
			} catch (e) {
				const rejected = /rejected|non-fast-forward|fetch first|failed to push/i.test(String(e));
				if (!rejected) {
					this.showNotice(e, 'ERROR', 10000);
					return false;
				}
				if (attempt === maxAttempts) {
					this.showNotice("Vault Digest: push rejected " + maxAttempts + " times, another device is pushing at the same time. Your commit is kept locally: sync again.", 'WARNING', 10000);
					return false;
				}
				await new Promise((resolve) => window.setTimeout(resolve, 150 + Math.random() * 450 * attempt));
				try {
					await git.pull('origin', this.branch, { '--rebase': null });
				} catch (pullError) {
					await git.rebase(['--abort']).catch(() => {});
					this.showNotice(String(pullError) + "\nVault Digest: could not rebase onto the remote after a rejected push.", 'ERROR', 10000);
					return false;
				}
				const st = await git.status().catch(() => undefined);
				if (!st) {
					return false;
				}
				if (st.conflicted.length > 0) {
					await this.reportConflicts(st.conflicted, undefined, interactive);
					return false;
				}
			}
		}
		return false;
	}

	// Files deleted on one side and modified on the other (git status DU / UD):
	// no markers, so a person has to choose between keeping and deleting the file.
	private modifyDeleteFiles(status: StatusResult): string[] {
		return status.files
			.filter((f) => ['DU', 'UD'].includes(f.index + f.working_dir))
			.map((f) => f.path);
	}

	// Conflicted files that still need a person: conflict markers still in the
	// file, or a modify/delete decision not taken yet.
	private async findUnresolvedConflicts(status: StatusResult): Promise<string[]> {
		const base = this.vaultPath();
		const needDecision = new Set(this.modifyDeleteFiles(status));
		const unresolved: string[] = [];
		for (const file of status.conflicted) {
			if (needDecision.has(file)) {
				unresolved.push(file);
				continue;
			}
			try {
				const text = await fs.readFile(path.join(base, file), "utf8");
				if (/^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)) {
					unresolved.push(file);
				}
			} catch {
				// Unreadable (e.g. deleted on both sides): counts as unresolved.
				unresolved.push(file);
			}
		}
		return unresolved;
	}

	// Decision for a modify/delete conflict: keep the modified file, or delete it.
	async ResolveFile(file: string, keep: boolean): Promise<void> {
		if (this.syncing || this.mergetoolOpen) {
			this.showNotice("Vault Digest: a sync is running, try again when it is done.", 'INFO');
			return;
		}
		this.initGit();
		try {
			if (keep) {
				await git.raw(['add', '--', file]);
			} else {
				await git.raw(['rm', '-f', '--', file]);
			}
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}
		const st = await git.status().catch(() => undefined);
		if (st && (await this.findUnresolvedConflicts(st)).length === 0) {
			this.showNotice("Conflicts resolved, syncing...", 'INFO');
			await this.SyncNotes(false);
		} else {
			this.showNotice(file + (keep ? " kept." : " deleted.") + " Other conflicts remain.", 'INFO');
		}
	}

	private async reportConflicts(conflicted: string[], note?: string, launchMergetool: boolean = false): Promise<void> {
		await this.showConflictNotice(conflicted, note, launchMergetool);
	}

	private async showConflictNotice(conflicted: string[], note: string | undefined, launchMergetool: boolean): Promise<void> {
		const status = await git.status().catch(() => undefined);
		const decisions = new Set(status ? this.modifyDeleteFiles(status) : []);

		let conflictMsg = "Merge conflicts in:";
		for (const c of conflicted) {
			conflictMsg += "\n\t" + c + (decisions.has(c) ? " (deleted on one side, modified on the other)" : "");
		}
		conflictMsg += "\nSync is suspended until these conflicts are resolved.";
		if (note) {
			conflictMsg += "\n" + note;
		}
		if (this.shouldShowNotice('WARNING')) {
			const fragment = createFragment((f) => {
				f.createDiv({ text: conflictMsg, cls: "vault-digest-notice-text" });
				const button = f.createEl("button", { text: "Resolve with git mergetool" });
				button.addEventListener("click", () => { void this.ResolveConflicts(); });
				for (const file of conflicted.filter((c) => decisions.has(c))) {
					const row = f.createDiv({ text: file + ": " });
					const keep = row.createEl("button", { text: "Keep file" });
					keep.addEventListener("click", () => { void this.ResolveFile(file, true); });
					const del = row.createEl("button", { text: "Delete file" });
					del.addEventListener("click", () => { void this.ResolveFile(file, false); });
				}
			});
			new Notice(fragment, 15000);
		}
		// Only a user-initiated sync opens the merge tool by itself; the notice
		// button and the command remain available otherwise.
		if (launchMergetool && conflicted.some((c) => !decisions.has(c))) {
			void this.ResolveConflicts();
		}
	}

	// Conflicts already reported while suspended, to not repeat the notice.
	private lastSuspendedKey = "";

	// True while a sync runs: the git client is shared, so syncs never overlap
	// (for example a ribbon click during a scheduled sync).
	private syncing = false;

	// interactive: started by a user action (ribbon, command). Only then may a new
	// conflict open the merge tool by itself; scheduled and startup syncs never do.
	async SyncNotes(interactive: boolean = false): Promise<void>
	{
		if (this.syncing) {
			this.showNotice("Vault Digest: a sync is already running.", 'INFO');
			return;
		}
		this.syncing = true;
		try {
			await this.runSync(interactive);
		} finally {
			this.syncing = false;
		}
	}

	private async runSync(interactive: boolean): Promise<void>
	{
		const remote = this.settings.remoteURL.trim();

		if (this.mergetoolOpen) {
			this.showNotice("Conflict resolution in progress: close the merge tool first.", 'INFO');
			return;
		}

		this.initGit();

		const hostname = os.hostname();

		const initialStatus = await git.status().catch(() => undefined);
		if (!initialStatus) {
			this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
			return;
		}
		let statusResult: StatusResult = initialStatus;

		const gitName = (await git.raw(['config', '--get', 'user.name']).catch(() => "")).trim();
		const gitEmail = (await git.raw(['config', '--get', 'user.email']).catch(() => "")).trim();
		if (!gitName || !gitEmail) {
			this.showNotice("Vault Digest: git author not configured. Run: git config --global user.name \"Your Name\" and git config --global user.email \"you@example.com\". Nothing was committed.", 'ERROR', 15000);
			return;
		}

		if (!this.isValidBranchName(this.branch)) {
			this.showNotice("Vault Digest: invalid main branch name \"" + this.branch + "\" in the settings.", 'ERROR', 10000);
			return;
		}
		if (statusResult.current && statusResult.current !== this.branch) {
			this.showNotice("Vault Digest: the vault is on branch \"" + statusResult.current + "\" but the main branch setting is \"" + this.branch + "\". Switch branch or change the setting.", 'ERROR', 10000);
			return;
		}

		// Suspend the sync while conflicts are unresolved: nothing is committed,
		// pulled or pushed until the conflict markers are gone.
		if (statusResult.conflicted.length > 0) {
			const unresolved = await this.findUnresolvedConflicts(statusResult);
			if (unresolved.length > 0) {
				// Scheduled and startup syncs repeat this check: report a given set of
				// conflicts once, a sync started by hand always reports.
				const key = unresolved.slice().sort().join("|");
				if (interactive || key !== this.lastSuspendedKey) {
					this.lastSuspendedKey = key;
					await this.reportConflicts(unresolved, undefined, false);
				}
				return;
			}
		}
		this.lastSuspendedKey = "";

		//@ts-ignore
		let clean = statusResult.isClean();

		// configure remote
		try {
			await git.removeRemote('origin').catch((e) => { this.showNotice(e, 'ERROR', 10000); });
			await git.addRemote('origin', remote).catch((e) => { this.showNotice(e, 'ERROR', 10000); });
		}
		catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}
		// check if remote url valid by fetching
		try {
			await git.fetch();
		} catch (e) {
			if (/could not resolve host|network is unreachable|connection timed out|operation timed out|connection refused|connection reset|temporary failure in name resolution|no route to host|failed to connect|could not connect|unable to connect|ssh: connect to host/i.test(String(e))) {
				// Offline or remote down: nothing is wrong with the setup, retry later.
				this.showNotice("Vault Digest: remote unreachable (offline?). Sync skipped, your notes are untouched.", 'WARNING', 8000);
			} else {
				this.showNotice(String(e) + "\nVault Digest: cannot fetch from the remote. Check the remote URL and your credentials.", 'ERROR', 10000);
			}
			return;
		}

		// remote changes about to be pulled (merge-base..origin/<branch>)
		const pulledDiff = await git.diffSummary(['HEAD...origin/' + this.branch]).catch(() => undefined);

		// Behind the remote with local edits: stash them, rebase onto the remote, then
		// unstash, so the new commit is made on top of up-to-date history.
		// Unstash conflict: the stash is kept and dropped automatically by the next
		// sync once the conflict is resolved. Any other failure: fall back to the
		// commit-then-pull flow below.
		let pulled = false;
		if (!clean) {
			const behind = await git.raw(['rev-list', '--count', 'HEAD..origin/' + this.branch])
				.then((r) => parseInt(r.trim(), 10) || 0)
				.catch(() => 0);
			if (behind > 0) {
				const stashed = await git.stash(['push', '--include-untracked', '-m', SYNC_STASH_MESSAGE])
					.then((out) => !out.includes('No local changes'))
					.catch(() => undefined);
				if (stashed !== undefined) {
					try {
						await git.pull('origin', this.branch, { '--rebase': null });
						pulled = true;
					} catch {
						await git.rebase(['--abort']).catch(() => {});
					}
					if (stashed) {
						// simple-git does not always throw when the pop stops on a conflict
						// (exit code 1 without stderr), so the status is always checked.
						let popError: string | undefined;
						try {
							await git.stash(['pop']);
						} catch (e) {
							popError = e instanceof Error ? e.message : String(e);
						}
						const popStatus = await git.status().catch(() => undefined);
						if (!popStatus) {
							return;
						}
						if (popStatus.conflicted.length > 0) {
							// Git keeps the stash entry; the next sync drops it once resolved.
							await this.reportConflicts(popStatus.conflicted,
								"Your local edits are kept in a git stash and are dropped automatically once the conflicts are resolved and you sync again.",
								interactive);
							return;
						}
						if (popError) {
							this.showNotice(popError + "\nVault Digest: your local edits are kept in a git stash (git stash list).", 'ERROR', 10000);
							return;
						}
					}
					if (pulled) {
						const afterPull = await git.status().catch(() => undefined);
						if (!afterPull) {
							return;
						}
						statusResult = afterPull;
					}
				}
			}
		}

		let pushedDiff: DiffResult | undefined;

		// git add .
		// git commit -m "vault: sync from <hostname> (<summary>)" -m "<file list>"
		if (!clean) {
			try {
				await git.add("./*");
				pushedDiff = await git.diffSummary(['--cached']).catch(() => undefined);
				await this.dropResolvedSyncStash();
				const digest = await this.computeDigest(pushedDiff);
				await git.commit(this.buildCommitMessage(statusResult, pushedDiff, digest, hostname));
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return;
		    }
		}

		// git pull --rebase origin main (linear history, no merge commits)
		// on rebase conflict: abort, then retry as a merge so conflicts can be resolved as before
		if (!pulled) {
		    try {
		    	try {
		    		await git.pull('origin', this.branch, { '--rebase': null });
		    	} catch {
		    		await git.rebase(['--abort']).catch(() => {});
		    		await git.pull('origin', this.branch, { '--no-rebase': null });
		    	}
		    } catch {
		    	const conflictStatus = await git.status().catch((error) => { this.showNotice(error, 'ERROR', 10000); return; });
		    	if (!conflictStatus) {
		    		return;
		    	}
		    	await this.reportConflicts(conflictStatus.conflicted, undefined, interactive);
		    	return;
		    }
		}

		// A pull can stop on conflicts without throwing: never go on to push them.
		const postPull = await git.status().catch(() => undefined);
		if (!postPull) {
			return;
		}
		if (postPull.conflicted.length > 0) {
			await this.reportConflicts(postPull.conflicted, undefined, interactive);
			return;
		}

		// git push origin main, whenever there is something to push: the commit made
		// above, or commits left unpushed by an earlier sync whose push failed.
		const ahead = await git.raw(['rev-list', '--count', 'origin/' + this.branch + '..HEAD'])
			.then((r) => parseInt(r.trim(), 10) || 0)
			.catch(() => 1);
		if (ahead > 0) {
			if (!(await this.pushWithRetry(interactive))) {
				return;
			}
		}

		this.showSyncSuccessNotice(clean ? undefined : pushedDiff, pulledDiff);
	}

	async CheckStatusOnStart()
	{
		// check status
		try {
			// Own client: the shared one belongs to the running sync.
			const startGit = simpleGit({
			    baseDir: this.vaultPath(),
			    binary: this.settings.gitLocation + "git",
			    maxConcurrentProcesses: 6,
			    trimmed: false,
			});

			//check for remote changes
			// git branch --set-upstream-to=origin/<branch>
			await startGit.branch({'--set-upstream-to': 'origin/' + this.branch});
			let statusUponOpening = await startGit.fetch().status();
			if (statusUponOpening.behind > 0)
			{
				// Automatically sync if needed
				if (this.settings.isSyncOnLoad == true)
				{
					void this.SyncNotes();
				}
				else
				{
					this.showNotice("Vault Digest: " + statusUponOpening.behind + " commits behind remote.\nClick the GitHub ribbon icon to sync.", 'WARNING');
				}
			}
			else
			{
				this.showNotice("Vault Digest: up to date with remote.", 'INFO');
			}
		} catch {
			// don't care
			// based
		}
	}

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with remote', () => {
			void this.SyncNotes(true);
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({
			id: 'resolve-conflicts',
			name: 'Resolve conflicts with git mergetool',
			callback: () => {
				void this.ResolveConflicts();
			}
		});

		this.addCommand({
			id: 'sync-with-remote',
			name: 'Sync with remote',
			callback: () => {
				void this.SyncNotes(true);
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		if (!isNaN(this.settings.syncinterval))
		{
			const interval: number = this.settings.syncinterval;
			if (interval >= 1)
			{
				// Cleared by Obsidian when the plugin unloads. SyncNotes skips a tick
				// while a sync is still running, so ticks never overlap.
				this.registerInterval(window.setInterval(() => {
					void this.SyncNotes();
				}, interval * 60 * 1000));
				this.showNotice("Auto sync enabled", 'INFO');
			}
		}

		if (this.settings.checkStatusOnLoad)
		{
			void this.CheckStatusOnStart();
		}
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<GHSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

type SettingKey = 'remoteURL' | 'branch' | 'gitLocation' | 'noticeLevel' | 'hideSyncSuccessNotice'
	| 'checkStatusOnLoad' | 'isSyncOnLoad' | 'syncinterval';

const README_URL = 'https://github.com/lideke/vault-digest/blob/main/README.md';

const asText = (value: unknown): string =>
	typeof value === 'string' ? value : typeof value === 'number' && !isNaN(value) ? String(value) : '';

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative settings (Obsidian 1.13+): rendered by Obsidian and indexed by
	// the settings search. display() below renders the same list on older versions.
	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				name: 'How to use this plugin',
				desc: createFragment((f) => {
					f.appendText("Paste your GitHub repository's HTTPS or SSH URL below. With HTTPS, the first sync prompts you to authenticate. With SSH already set up for GitHub on this device, no authentication is needed. See the ");
					f.createEl('a', { href: README_URL, text: 'README' });
					f.appendText(' for more information and troubleshooting.');
				}),
				searchable: false,
			},
			{
				name: 'Remote URL',
				desc: 'HTTPS or SSH URL of the GitHub repository to sync with.',
				aliases: ['github', 'repository', 'origin'],
				control: { type: 'text', key: 'remoteURL', placeholder: 'git@github.com:user/vault.git' },
			},
			{
				name: 'Main branch',
				desc: 'Branch to pull from and push to. The vault must be on this branch. Default: main.',
				control: { type: 'text', key: 'branch', placeholder: 'main' },
			},
			{
				name: 'Git binary location',
				desc: 'Optional. Set this only if git cannot be found through your system PATH. See the README for more info.',
				control: { type: 'text', key: 'gitLocation' },
			},
			{
				type: 'group',
				heading: 'Notices',
				items: [
					{
						name: 'Notice level',
						desc: 'Choose which Vault Digest notices are shown.',
						control: { type: 'dropdown', key: 'noticeLevel', options: { ALL: 'All', WARNING: 'Warnings and errors', ERROR: 'Errors only' } },
					},
					{
						name: 'Hide success message',
						desc: 'Hide the notice shown when a sync finishes successfully.',
						control: { type: 'toggle', key: 'hideSyncSuccessNotice' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Automatic sync',
				items: [
					{
						name: 'Check status on startup',
						desc: 'Check whether you are behind the remote when Obsidian starts.',
						control: { type: 'toggle', key: 'checkStatusOnLoad' },
					},
					{
						name: 'Auto sync on startup',
						desc: 'Sync with the remote when Obsidian starts if there are unsynced changes.',
						control: { type: 'toggle', key: 'isSyncOnLoad' },
					},
					{
						name: 'Auto sync at interval',
						desc: 'Minutes between automatic syncs. 0 disables auto sync. Restart Obsidian to apply.',
						control: { type: 'number', key: 'syncinterval', min: 0, step: 1, placeholder: '0' },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const settings = this.plugin.settings;
		if (key === 'hideSyncSuccessNotice') {
			return !settings.showSyncSuccessNotice;
		}
		return settings[key as keyof GHSyncSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		switch (key as SettingKey) {
			case 'remoteURL':
				settings.remoteURL = asText(value);
				break;
			case 'gitLocation':
				settings.gitLocation = asText(value);
				break;
			case 'branch':
				settings.branch = asText(value).trim() || 'main';
				break;
			case 'noticeLevel':
				settings.noticeLevel = asText(value) as NoticeLevelSetting;
				break;
			case 'hideSyncSuccessNotice':
				settings.showSyncSuccessNotice = value !== true;
				break;
			case 'checkStatusOnLoad':
				settings.checkStatusOnLoad = value === true;
				break;
			case 'isSyncOnLoad':
				settings.isSyncOnLoad = value === true;
				break;
			case 'syncinterval':
				settings.syncinterval = Number(value);
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
	}

	// Fallback for Obsidian older than 1.13, which never calls getSettingDefinitions().
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const item of this.getSettingDefinitions()) {
			if ('type' in item && item.type === 'group') {
				if (item.heading) {
					new Setting(containerEl).setName(item.heading).setHeading();
				}
				for (const child of item.items ?? []) {
					if (!('type' in child)) {
						this.renderFallback(containerEl, child);
					}
				}
			} else if (!('type' in item)) {
				this.renderFallback(containerEl, item);
			}
		}
	}

	private renderFallback(containerEl: HTMLElement, def: SettingDefinition<SettingKey>): void {
		const setting = new Setting(containerEl).setName(def.name);
		if (def.desc) {
			setting.setDesc(def.desc);
		}
		const control = def.control;
		if (!control) {
			return;
		}
		const save = (value: unknown) => { void this.setControlValue(control.key, value); };
		const current = this.getControlValue(control.key);
		switch (control.type) {
			case 'text':
				setting.addText((text) => text
					.setPlaceholder(control.placeholder ?? '')
					.setValue(asText(current))
					.onChange(save));
				break;
			case 'number':
				setting.addText((text) => text
					.setPlaceholder(control.placeholder ?? '')
					.setValue(asText(current))
					.onChange((value) => save(Number(value))));
				break;
			case 'toggle':
				setting.addToggle((toggle) => toggle
					.setValue(current === true)
					.onChange(save));
				break;
			case 'dropdown':
				setting.addDropdown((dropdown) => dropdown
					.addOptions(control.options)
					.setValue(asText(current))
					.onChange(save));
				break;
		}
	}
}
