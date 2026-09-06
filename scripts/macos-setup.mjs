// Local deployment utility. Secrets are read/written in private files, never logged.
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vault = '/Volumes/Disk2/Documentos/SamuelGuzman';
const runtime = join(homedir(), 'Library/Application Support/Recall Backend');
const plugin = join(vault, '.obsidian/plugins/obsidian-recall');
process.umask(0o077);

async function inventory(root, prefix = '') {
  const rows = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${path}`);
    if (entry.isDirectory()) rows.push(...await inventory(root, path));
    else {
      const bytes = await readFile(join(root, path));
      rows.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return rows;
}
async function verifiedBackup() {
  const root = await mkdtemp('/Volumes/Disk2/Documentos/SamuelGuzman-backup-recall-backend-20260906-');
  for (const [source, target] of [
    [join(vault, 'recall-data'), 'recall-data'], [plugin, 'plugin'],
    [join(vault, '.obsidian/community-plugins.json'), 'community-plugins.json'],
    [join(homedir(), 'Library/Application Support/obsidian/obsidian.json'), 'obsidian-app.json'],
  ]) await cp(source, join(root, target), { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  const manifest = await inventory(root);
  const original = await inventory(join(vault, 'recall-data'));
  const copy = manifest.filter(f => f.path.startsWith('recall-data/')).map(f => ({ ...f, path: f.path.slice(12) }));
  if (JSON.stringify(original) !== JSON.stringify(copy)) throw new Error(`Backup verification failed: ${root}`);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), vault, files: manifest }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ backup: root, files: manifest.length, verifiedRecallFiles: original.length }));
}
async function prepare(backup) {
  if (!backup || !backup.startsWith('/Volumes/Disk2/Documentos/SamuelGuzman-backup-recall-backend-')) throw new Error('Provide the verified backup directory');
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) {
    const bytes = await readFile(join(backup, entry.path));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Backup changed: ${entry.path}`);
  }
  try { await stat(join(runtime, 'backend.env')); throw new Error('Runtime already configured; refusing to overwrite'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const sub of ['', 'server', 'data', 'logs', 'backups']) await mkdir(join(runtime, sub), { recursive: true, mode: 0o700 });
  const settings = JSON.parse(await readFile(join(backup, 'plugin/data.json'), 'utf8'));
  const token = settings.voiceApi?.token?.length >= 32 ? settings.voiceApi.token : randomBytes(32).toString('hex');
  const env = {
    RECALL_TOKEN: token, RECALL_HOST: '127.0.0.1', RECALL_PORT: '27124', RECALL_DB: join(runtime, 'data/recall.sqlite'),
    TZ: 'Europe/Madrid', RECALL_TAGS: settings.flashcardTags.join(','), RECALL_DAILY_NEW: String(settings.dailyNewLimit),
    RECALL_BACKUP_MIRROR: '/Volumes/Disk2/Documentos/Recall-backend-backups',
    RECALL_DAILY_REVIEW: String(settings.dailyReviewLimit), RECALL_LEECH_THRESHOLD: String(settings.leechThreshold),
    RECALL_SHUFFLE: String(settings.shuffleReviews), RECALL_AUDIO_DIR: join(runtime, 'data/audio'),
    RECALL_TTS_KEY: settings.voiceTts?.enabled ? settings.voiceTts.apiKey : '',
    RECALL_TTS_VOICE: settings.voiceTts?.voice ?? 'alloy', RECALL_TTS_MODEL: settings.voiceTts?.model ?? 'gpt-4o-mini-tts',
    RECALL_TTS_INSTRUCTIONS: settings.voiceTts?.instructions ?? '',
    RECALL_LLM_PROVIDER: settings.voiceTts?.llmPreprocess ? settings.llmProvider : 'none',
    RECALL_LLM_KEY: settings.voiceTts?.llmPreprocess ? settings.llmApiKey : '',
    RECALL_LLM_MODEL: settings.llmModel ?? '',
  };
  // Node's env-file parser supports literal multiline values in single quotes.
  const quote = value => {
    if (value.includes("'")) {
      if (value.includes('`')) throw new Error('Unsupported quote combination in environment value');
      return '`' + value + '`';
    }
    return "'" + value + "'";
  };
  await writeFile(join(runtime, 'backend.env'), Object.entries(env).map(([k,v]) => `${k}=${quote(v)}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  for (const name of ['main.cjs', 'migrate.cjs']) await cp(join(repo, 'dist/server', name), join(runtime, 'server', name), { errorOnExist: true, force: false });
  await writeFile(join(runtime, 'deployment.json'), JSON.stringify({ repo, vault, backup, node: process.execPath, created: new Date().toISOString() }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ runtime, backup, configWritten: true, secretsPrinted: false }));
}
async function installPlugin() {
  const deployment = JSON.parse(await readFile(join(runtime, 'deployment.json'), 'utf8'));
  const current = await readFile(join(plugin, 'data.json'));
  const previous = await readFile(join(deployment.backup, 'plugin/data.json'));
  if (!current.equals(previous)) throw new Error('Plugin settings changed since backup; refusing replacement');
  process.loadEnvFile(join(runtime, 'backend.env'));
  const settings = JSON.parse(current);
  settings.backend = { enabled: true, url: 'http://127.0.0.1:27124', token: process.env.RECALL_TOKEN, syncNotes: true };
  settings.voiceApi.enabled = false;
  for (const name of ['main.js', 'styles.css']) await cp(join(repo, name), join(plugin, name));
  // Preserve the installed plugin identity/manifest rather than replacing unrelated metadata.
  await writeFile(join(plugin, 'data.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
  await chmod(join(plugin, 'data.json'), 0o600);
  console.log('Plugin installed in remote mode; local recall-data retained unchanged.');
}
async function stageIndex() {
  const deployment = JSON.parse(await readFile(join(runtime, 'deployment.json'), 'utf8'));
  const source = join(deployment.backup, 'recall-data');
  const target = join(runtime, 'migration-input');
  await mkdir(target, { mode: 0o700 }); // Refuse overwriting an earlier staging area.
  for (const name of await readdir(source)) {
    if (/^(concepts|study-items|decks|sync-state|reviews(?:-[^.]+)?)\.json$/.test(name)) {
      await cp(join(source, name), join(target, name), { errorOnExist: true, force: false });
    }
  }
  const json = async name => JSON.parse(await readFile(join(target, name + '.json'), 'utf8'));
  const [concepts, items, decks, state] = await Promise.all(['concepts', 'study-items', 'decks', 'sync-state'].map(json));
  const report = { source, target, repairedNotes: [], removedStaleTagReferences: 0 };
  for (const [path, index] of Object.entries(state.fileIndices)) {
    const old = JSON.stringify(index);
    index.cardKeys = Object.fromEntries(Object.entries(index.cardKeys).filter(([, id]) => concepts[id]));
    index.conceptLines = Object.fromEntries(Object.entries(index.conceptLines ?? {}).filter(([id]) => concepts[id]));
    index.studyItemIds = index.studyItemIds.filter(id => items[id]);
    index.deckIds = index.deckIds.filter(id => decks[id]);
    if (old !== JSON.stringify(index)) report.repairedNotes.push(path);
  }
  const entries = Object.entries(state.tagToDeckId);
  state.tagToDeckId = Object.fromEntries(entries.filter(([, id]) => decks[id]));
  report.removedStaleTagReferences = entries.length - Object.keys(state.tagToDeckId).length;
  await writeFile(join(target, 'sync-state.json'), JSON.stringify(state, null, 2));
  // Assert all real entities and history are byte-for-byte copies. Only the derived index changes.
  for (const name of await readdir(target)) if (name !== 'sync-state.json') {
    if (!(await readFile(join(target, name))).equals(await readFile(join(source, name)))) throw new Error(`Unexpected data mutation: ${name}`);
  }
  await writeFile(join(runtime, 'migration-index-repair.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ target, repairedNotes: report.repairedNotes.length, actualEntitiesAndHistoryUnchanged: true }));
}
async function migrateCaches() {
  const deployment = JSON.parse(await readFile(join(runtime, 'deployment.json'), 'utf8'));
  process.loadEnvFile(join(runtime, 'backend.env'));
  const audio = join(runtime, 'data/audio');
  await mkdir(audio, { recursive: true, mode: 0o700 });
  let copiedAudio = 0, copiedRewrites = 0;
  for (const name of await readdir(join(deployment.backup, 'recall-data/voice-cache'))) {
    const match = /^([a-f0-9-]{36})-([qa])-([a-f0-9]{12})\.mp3$/.exec(name);
    if (!match) continue;
    const id = createHash('sha256').update(match[1]).digest('hex');
    await cp(join(deployment.backup, 'recall-data/voice-cache', name), join(audio, `${id}-${match[2]}-${match[3]}.mp3`), { errorOnExist: true, force: false });
    copiedAudio++;
  }
  const rewrites = join(audio, 'rewrites', process.env.RECALL_LLM_PROVIDER,
    process.env.RECALL_LLM_MODEL?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default');
  await mkdir(rewrites, { recursive: true, mode: 0o700 });
  for (const name of await readdir(join(deployment.backup, 'recall-data/voice-rewrite-cache'))) {
    if (!/^[a-f0-9]{12}\.txt$/.test(name)) continue;
    await cp(join(deployment.backup, 'recall-data/voice-rewrite-cache', name), join(rewrites, name), { errorOnExist: true, force: false });
    copiedRewrites++;
  }
  console.log(JSON.stringify({ copiedAudio, copiedRewrites, sourceUntouched: true }));
}
const [command, argument] = process.argv.slice(2);
if (command === 'backup') await verifiedBackup();
else if (command === 'prepare') await prepare(argument);
else if (command === 'install-plugin') await installPlugin();
else if (command === 'stage-index') await stageIndex();
else if (command === 'migrate-caches') await migrateCaches();
else throw new Error('Usage: node scripts/macos-setup.mjs backup|prepare <backup>|stage-index|migrate-caches|install-plugin');
