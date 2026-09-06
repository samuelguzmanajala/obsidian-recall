import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, stat, readFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
process.umask(0o077);
if (!process.env.RECALL_DB) throw new Error('RECALL_DB must point to the installed database');
const source = resolve(process.env.RECALL_DB);
await stat(source); // Never silently create a missing source database.
const directory = resolve(process.env.RECALL_BACKUP_DIR ?? join(dirname(source), '../backups'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const destination = join(directory, `recall-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); } finally { db.close(); }
const check = new DatabaseSync(destination, { readOnly: true });
try {
  const result = check.prepare('PRAGMA integrity_check').get();
  if (result.integrity_check !== 'ok') throw new Error('Backup integrity check failed');
  const reviews = check.prepare("SELECT value FROM documents WHERE key='reviews'").get();
  const hash = createHash('sha256').update(await readFile(destination)).digest('hex');
  let mirror = null;
  if (process.env.RECALL_BACKUP_MIRROR) {
    const folder = resolve(process.env.RECALL_BACKUP_MIRROR);
    try {
      // Do not manufacture a missing mount point if the external disk is disconnected.
      await stat(dirname(folder));
      try { await mkdir(folder, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      mirror = join(folder, basename(destination));
      await copyFile(destination, mirror, constants.COPYFILE_EXCL);
      if (createHash('sha256').update(await readFile(mirror)).digest('hex') !== hash) throw new Error('Mirror verification failed');
    } catch (e) { mirror = null; console.error(`Backup local correcto; copia externa pendiente: ${e.code ?? e.message}`); }
  }
  console.log(JSON.stringify({ backup: destination, mirror, integrity: 'ok', reviews: reviews ? JSON.parse(reviews.value).length : 0, sha256: hash }));
} finally { check.close(); }
