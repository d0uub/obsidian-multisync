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

/**
 * requestUrl mock — uses Node fetch when INTEGRATION_TEST env is set,
 * otherwise returns empty (unit test mode).
 */
export async function requestUrl(opts: any): Promise<any> {
  if (!process.env.INTEGRATION_TEST) {
    return { json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} };
  }
  // Real HTTP via Node fetch for integration tests
  const { url, method = "GET", headers = {}, body } = opts;
  const fetchOpts: RequestInit = { method, headers };
  if (body !== undefined) {
    fetchOpts.body = body instanceof ArrayBuffer ? body : body;
  }
  const resp = await fetch(url, fetchOpts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err: any = new Error(`Request failed: ${resp.status} ${text}`);
    err.status = resp.status;
    throw err;
  }
  const buf = await resp.arrayBuffer();
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  let json: any;
  try {
    json = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    json = {};
  }
  return { json, arrayBuffer: buf, headers: respHeaders };
}
