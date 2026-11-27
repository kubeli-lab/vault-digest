export const notices: string[] = [];
export class Notice { constructor(m: any, _t?: number) { notices.push(typeof m === 'string' ? m : (m && m.__text) || '[fragment]'); } }
export class Plugin { app: any; manifest: any; constructor(app: any, manifest: any) { this.app = app; this.manifest = manifest; }
  addCommand() {} addRibbonIcon() { return { addClass() {} }; } addSettingTab() {} registerInterval() {} async loadData() { return {}; } async saveData() {} }
export class PluginSettingTab { constructor(public app: any, public plugin: any) {} }
export class Setting { constructor(_: any) {} setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } }
export class App {}
export class FileSystemAdapter { constructor(private base: string) {} getBasePath() { return this.base; } }
