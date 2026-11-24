import { TFile, TFolder, normalizePath, type Vault } from 'obsidian';
import type { InboxVault } from './proposal-inbox';

/**
 * The plugin's only write access to the vault, used by `ProposalInbox` for the inbox notes. Goes
 * through Obsidian's vault API, so the usual create/modify events publish the note.
 */
export function obsidianInboxVault(vault: Vault): InboxVault {
  const file = (path: string) => {
    const found = vault.getAbstractFileByPath(normalizePath(path));
    return found instanceof TFile ? found : null;
  };
  return {
    async read(path) {
      const found = file(path);
      return found ? vault.read(found) : null;
    },
    async create(path, content) {
      const normalized = normalizePath(path);
      const folders = normalized.split('/').slice(0, -1);
      for (let i = 1; i <= folders.length; i++) {
        const folder = folders.slice(0, i).join('/');
        const existing = vault.getAbstractFileByPath(folder);
        if (!existing) await vault.createFolder(folder);
        else if (!(existing instanceof TFolder)) throw new Error(`${folder} is a file, not a folder`);
      }
      await vault.create(normalized, content);
    },
    async process(path, change) {
      const found = file(path);
      if (!found) throw new Error('the note is no longer there');
      await vault.process(found, change);
    },
  };
}
