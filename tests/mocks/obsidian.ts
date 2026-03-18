// Minimal mock of obsidian module for testing
export class Notice {
  constructor(public message: string) {}
}
export class Plugin {}
export class PluginSettingTab {}
export class Modal {
  app: any;
  contentEl: any = { empty() {}, createEl() {} };
  constructor(app: any) { this.app = app; }
  open() {}
  close() {}
}
export class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addButton() { return this; }
  addDropdown() { return this; }
  addSearch() { return this; }
}
export class AbstractInputSuggest<T> {
  constructor(_app: any, _inputEl: any) {}
  close() {}
}
export const Platform = {
  isDesktopApp: false,
  isMacOS: false,
};
export function requestUrl(_opts: any): Promise<any> {
  return Promise.resolve({ json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
}
