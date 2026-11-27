// Note-aware summary of a staged markdown diff.
//
// Pure, single pass, no git or file access: it only reads the text of one
// `git diff --cached -U0` output, so its cost is linear in the diff size.

export interface NoteDigest {
	linksAdded: string[];
	linksRemoved: string[];
	tagsAdded: string[];
	tagsRemoved: string[];
	tasksDone: number;
	tasksNew: number;
}

// Above this many changed lines the digest is skipped to keep sync fast.
export const MAX_DIGEST_LINES = 20000;

const LINK_RE = /\[\[([^\]|#^]+)/g;
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g;
const DONE_TASK_RE = /^\s*[-*+]\s+\[[xX]\]\s*/;
const OPEN_TASK_RE = /^\s*[-*+]\s+\[ \]\s*/;

type Counter = Map<string, number>;

function bump(map: Counter, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

const FRONTMATTER_TAGS_RE = /^\s*tags?\s*:\s*(.+)$/i;

// Inline frontmatter forms only: `tags: [a, b]`, `tags: a, b`, `tags: a b`.
// Block lists (`tags:` then `- a`) cannot be told from a body list in a diff
// without context lines, so they are not read.
function collectFrontmatterTags(line: string, tags: Counter): void {
	const m = FRONTMATTER_TAGS_RE.exec(line);
	if (m === null) {
		return;
	}
	for (const raw of m[1].replace(/[[\]"']/g, "").split(/[,\s]+/)) {
		const tag = raw.replace(/^#/, "").trim();
		if (/^[A-Za-z][\w/-]*$/.test(tag)) {
			bump(tags, tag);
		}
	}
}

function collect(line: string, links: Counter, tags: Counter): void {
	collectFrontmatterTags(line, tags);
	if (line.indexOf("[[") !== -1) {
		LINK_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = LINK_RE.exec(line)) !== null) {
			bump(links, m[1].trim());
		}
	}
	if (line.indexOf("#") !== -1) {
		TAG_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = TAG_RE.exec(line)) !== null) {
			bump(tags, m[1]);
		}
	}
}

function isMarkdownPath(raw: string): boolean {
	const p = raw.replace(/\t.*$/, "").replace(/"$/, "");
	return p.endsWith(".md");
}

export function analyzeDiff(diff: string): NoteDigest {
	const linksAdded = new Set<string>();
	const linksRemoved = new Set<string>();
	const tagsAdded = new Set<string>();
	const tagsRemoved = new Set<string>();
	let tasksDone = 0;
	let tasksNew = 0;

	// Per-file counters, flushed on file change: a token that only moved
	// inside one note nets out to zero and is not reported.
	let addL: Counter = new Map(), remL: Counter = new Map();
	let addT: Counter = new Map(), remT: Counter = new Map();
	// Tasks are keyed by their text so a toggled task ("[ ]" -> "[x]") is told
	// apart from a brand-new one.
	let addDone: Counter = new Map(), remDone: Counter = new Map();
	let addOpen: Counter = new Map(), remOpen: Counter = new Map();

	const net = (a: Counter, r: Counter, outAdded: Set<string>, outRemoved: Set<string>) => {
		a.forEach((n, k) => { if (n > (r.get(k) ?? 0)) { outAdded.add(k); } });
		r.forEach((n, k) => { if (n > (a.get(k) ?? 0)) { outRemoved.add(k); } });
	};

	const flush = () => {
		net(addL, remL, linksAdded, linksRemoved);
		net(addT, remT, tagsAdded, tagsRemoved);
		addDone.forEach((n, k) => {
			const toggled = Math.min(Math.max(0, n - (remDone.get(k) ?? 0)), remOpen.get(k) ?? 0);
			tasksDone += toggled;
		});
		addOpen.forEach((n, k) => {
			tasksNew += Math.max(0, n - (remOpen.get(k) ?? 0) - (remDone.get(k) ?? 0));
		});
		addL = new Map(); remL = new Map();
		addT = new Map(); remT = new Map();
		addDone = new Map(); remDone = new Map();
		addOpen = new Map(); remOpen = new Map();
	};

	let inMarkdown = false;
	// File headers (---/+++) only occur before the first hunk of a file; inside
	// a hunk a removed "-- x" line would otherwise look like a header.
	let inHunk = false;
	let pos = 0;
	const len = diff.length;

	while (pos < len) {
		let end = diff.indexOf("\n", pos);
		if (end === -1) {
			end = len;
		}
		const c = diff.charCodeAt(pos);

		if (c === 100 /* d */ && diff.startsWith("diff --git ", pos)) {
			flush();
			inMarkdown = false;
			inHunk = false;
		} else if (c === 64 /* @ */ && diff.startsWith("@@", pos)) {
			inHunk = true;
		} else if (!inHunk && c === 43 /* + */ && diff.startsWith("+++ ", pos)) {
			const path = diff.slice(pos + 4, end);
			inMarkdown = path !== "/dev/null" && isMarkdownPath(path);
		} else if (!inHunk && c === 45 /* - */ && diff.startsWith("--- ", pos)) {
			const path = diff.slice(pos + 4, end);
			if (path !== "/dev/null") {
				inMarkdown = isMarkdownPath(path);
			}
		} else if (inMarkdown && (c === 43 || c === 45)) {
			const line = diff.slice(pos + 1, end);
			if (c === 43) {
				collect(line, addL, addT);
				let m: RegExpExecArray | null;
				if ((m = DONE_TASK_RE.exec(line)) !== null) { bump(addDone, line.slice(m[0].length)); }
				else if ((m = OPEN_TASK_RE.exec(line)) !== null) { bump(addOpen, line.slice(m[0].length)); }
			} else {
				collect(line, remL, remT);
				let m: RegExpExecArray | null;
				if ((m = DONE_TASK_RE.exec(line)) !== null) { bump(remDone, line.slice(m[0].length)); }
				else if ((m = OPEN_TASK_RE.exec(line)) !== null) { bump(remOpen, line.slice(m[0].length)); }
			}
		}

		pos = end + 1;
	}
	flush();

	return {
		linksAdded: Array.from(linksAdded),
		linksRemoved: Array.from(linksRemoved),
		tagsAdded: Array.from(tagsAdded),
		tagsRemoved: Array.from(tagsRemoved),
		tasksDone,
		tasksNew,
	};
}

// Short summary parts for the commit subject, e.g. ["+3 links", "5 tasks done"].
export function digestSummary(d: NoteDigest): string[] {
	const parts: string[] = [];
	if (d.linksAdded.length > 0) { parts.push("+" + d.linksAdded.length + " links"); }
	if (d.linksRemoved.length > 0) { parts.push("-" + d.linksRemoved.length + " links"); }
	if (d.tagsAdded.length > 0) { parts.push("+" + d.tagsAdded.length + " tags"); }
	if (d.tagsRemoved.length > 0) { parts.push("-" + d.tagsRemoved.length + " tags"); }
	if (d.tasksDone > 0) { parts.push(d.tasksDone + " tasks done"); }
	if (d.tasksNew > 0) { parts.push(d.tasksNew + " new tasks"); }
	return parts;
}

// Detail lines for the commit body, naming what changed (capped).
export function digestDetails(d: NoteDigest, maxNames = 5): string[] {
	const lines: string[] = [];
	const list = (label: string, items: string[], wrap: (s: string) => string) => {
		if (items.length === 0) {
			return;
		}
		const shown = items.slice(0, maxNames).map(wrap).join(", ");
		const more = items.length > maxNames ? " (+" + (items.length - maxNames) + " more)" : "";
		lines.push(label + ": " + shown + more);
	};
	list("Links added", d.linksAdded, (s) => "[[" + s + "]]");
	list("Links removed", d.linksRemoved, (s) => "[[" + s + "]]");
	list("Tags added", d.tagsAdded, (s) => "#" + s);
	list("Tags removed", d.tagsRemoved, (s) => "#" + s);
	return lines;
}

// Commit message size limits: the subject stays on one readable line and the
// body stays bounded however many notes changed.
export const MAX_SUBJECT = 100;
export const MAX_BODY_LINE = 100;
export const MAX_BODY_CHARS = 1500;

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

// Drops trailing parts (digest first, then counts) until the subject fits.
export function fitSubject(prefix: string, parts: string[], max: number = MAX_SUBJECT): string {
	const kept = parts.slice();
	const build = () => (kept.length > 0 ? prefix + " (" + kept.join("; ") + ")" : prefix);
	while (kept.length > 1 && build().length > max) {
		kept.pop();
	}
	return truncate(build(), max);
}

// Truncates each line and stops once the character budget is used, ending
// with "... and N more" so the cut is visible.
export function fitBody(lines: string[], maxChars: number = MAX_BODY_CHARS, maxLine: number = MAX_BODY_LINE): string[] {
	const out: string[] = [];
	let used = 0;
	const reserve = 24;
	for (let i = 0; i < lines.length; i++) {
		const line = truncate(lines[i], maxLine);
		if (used + line.length + 1 > maxChars - reserve) {
			const rest = lines.slice(i).filter((l) => l !== "").length;
			out.push("... and " + rest + " more");
			break;
		}
		out.push(line);
		used += line.length + 1;
	}
	return out;
}
