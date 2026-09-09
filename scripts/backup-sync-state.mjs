// Snapshot the stopped Obsidian publisher, including durable journals/cursors.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
process.umask(0o077);
try {
  execFileSync('/usr/bin/pgrep', ['-x', 'Obsidian'], { stdio: 'ignore' });
  throw new Error('Close Obsidian before backing up its local journals');
} catch (error) { if (error.status !== 1) throw error; }
const root = '/Users/samuelguzman/Library/Application Support/Recall Backend/backups';
const backup = join(root, `sync-conflict-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(backup, { mode: 0o700 });
const sources = {
  'local-storage': '/Users/samuelguzman/Library/Application Support/obsidian/Local Storage',
  plugin: '/Volumes/Disk2/Documentos/SamuelGuzman/.obsidian/plugins/obsidian-recall',
};
const manifest = [];
async function verify(source, destination, relative) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await verify(join(source, entry.name), join(destination, entry.name), join(relative, entry.name));
    else if (entry.isFile()) {
      const [before, after] = await Promise.all([readFile(join(source, entry.name)), readFile(join(destination, entry.name))]);
      if (!before.equals(after)) throw new Error('Backup verification failed');
      manifest.push({ path: join(relative, entry.name), bytes: after.length, sha256: createHash('sha256').update(after).digest('hex') });
    } else throw new Error('Unexpected non-regular file in backup source');
  }
}
for (const [name, source] of Object.entries(sources)) {
  await cp(source, join(backup, name), { recursive: true, errorOnExist: true, force: false });
  await verify(source, join(backup, name), name);
}
await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log({ backup, verifiedFiles: manifest.length });
