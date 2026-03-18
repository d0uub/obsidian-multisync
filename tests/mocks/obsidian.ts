// Minimal mock of obsidian module for testing
export class Notice {
  constructor(public message: string) {}
}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
}
export function requestUrl(_opts: any): Promise<any> {
  return Promise.resolve({ json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
}
