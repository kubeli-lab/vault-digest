import GHSyncPlugin from '../main';
import { notices, FileSystemAdapter } from './obsidian-stub';
(globalThis as any).window = globalThis;
(globalThis as any).createFragment = (cb: any) => { const t: string[] = []; const f: any = { __text: '', createDiv: (o: any) => { t.push(o.text); const el: any = { style: {}, createEl: () => ({ addEventListener() {} }), createDiv: (o2: any) => { t.push(o2.text); return el; } }; return el; }, createEl: () => ({ addEventListener() {} }) }; cb(f); f.__text = t.join(' '); return f; };
const [vault, remote, cmd, interactive] = process.argv.slice(2);
const opened: any[] = [];
const app: any = { vault: { adapter: new FileSystemAdapter(vault) }, workspace: { openLinkText: (...a: any[]) => opened.push(a) } };
const p: any = new GHSyncPlugin(app, {} as any);
p.settings = { remoteURL: remote, gitLocation: '', branch: process.env.BRANCH || 'main', syncinterval: 0, isSyncOnLoad: false, checkStatusOnLoad: false, noticeLevel: 'ALL', showSyncSuccessNotice: true };
(async () => {
  if (cmd === 'resolve') { await p.ResolveConflicts(); } else if (cmd.startsWith('keep:')) { await p.ResolveFile(cmd.slice(5), true); } else if (cmd.startsWith('delete:')) { await p.ResolveFile(cmd.slice(7), false); } else if (cmd === 'repeat') { await p.SyncNotes(false); await p.SyncNotes(false); await p.SyncNotes(false); await p.SyncNotes(true); } else if (cmd === 'double') { await Promise.all([p.SyncNotes(), p.SyncNotes(), p.SyncNotes()]); } else { await p.SyncNotes(interactive === 'true'); }
  console.log('__NOTICES__' + JSON.stringify(notices));
})().catch((e) => { console.log('__NOTICES__' + JSON.stringify(notices.concat(['CRASH ' + e]))); });
