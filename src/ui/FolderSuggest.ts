import { App, AbstractInputSuggest } from "obsidian";

/**
 * Folder suggest dropdown for local vault folder selection.
 * Uses Obsidian's built-in AbstractInputSuggest for native look & feel.
 */
export class FolderSuggest extends AbstractInputSuggest<string> {
  private folders: string[];
  private textInputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.textInputEl = inputEl;
    this.folders = ["(entire vault)"];
    const allFolders = app.vault.getAllFolders();
    for (const folder of allFolders) {
      if (folder.path) this.folders.push(folder.path);
    }
    this.folders.sort();
  }

  getSuggestions(inputStr: string): string[] {
    const lower = inputStr.toLowerCase();
    if (!lower) return this.folders;
    return this.folders.filter((f) => f.toLowerCase().includes(lower));
  }

  renderSuggestion(folder: string, el: HTMLElement): void {
    el.createEl("div", { text: folder });
  }

  selectSuggestion(folder: string): void {
    const value = folder === "(entire vault)" ? "" : folder;
    this.textInputEl.value = value;
    this.textInputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}
