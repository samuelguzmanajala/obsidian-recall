// Run after tests/build, with Obsidian closed. Preserve settings and manifest.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
process.umask(0o077);
try {
  execFileSync('/usr/bin/pgrep', ['-x', 'Obsidian'], { stdio: 'ignore' });
  throw new Error('Close Obsidian before updating');
} catch (error) { if (error.status !== 1) throw error; }
const root = '/Users/samuelguzman/Library/Application Support/Recall Backend/backups';
const backup = join(root, `plugin-refresh-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const target = '/Volumes/Disk2/Documentos/SamuelGuzman/.obsidian/plugins/obsidian-recall';
await mkdir(backup, { mode: 0o700 });
for (const name of ['main.js', 'styles.css', 'manifest.json', 'data.json']) {
  await copyFile(join(target, name), join(backup, name));
  if (!(await readFile(join(target, name))).equals(await readFile(join(backup, name)))) throw new Error('Backup verification failed');
}
for (const name of ['main.js', 'styles.css']) {
  const source = new URL(`../${name}`, import.meta.url);
  await copyFile(source, join(target, name));
  if (!(await readFile(source)).equals(await readFile(join(target, name)))) throw new Error('Installation verification failed');
}
await writeFile(join(backup, 'installation.json'), JSON.stringify({
  installedMainSha256: createHash('sha256').update(await readFile(join(target, 'main.js'))).digest('hex'),
  settingsPreserved: true,
}, null, 2));
console.log(JSON.stringify({ backup, installed: true, settingsPreserved: true }));
