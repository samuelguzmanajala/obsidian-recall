// Run only with the user's phone connected and no review session in progress.
// Backs up app-private data when available and updates in place; never uninstalls.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
process.umask(0o077);
const adb = '/opt/homebrew/share/android-commandlinetools/platform-tools/adb';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' }).split('\n')
  .map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === 'device');
if (devices.length !== 1) throw new Error('Conecta y autoriza exactamente un telefono por USB antes de continuar.');
const serial = devices[0][0];
const run = args => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8' });
if (process.argv[2] !== '--apply') {
  console.log({ device: serial, installed: !!run(['shell', 'pm', 'path', 'com.recall.voice']).trim(),
    next: 'Cierra la sesion de repaso y ejecuta de nuevo con --apply.' });
  process.exit(0);
}
const root = join(homedir(), 'Library/Application Support/Recall Backend/backups', `android-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(root, { mode: 0o700 });
const installed = run(['shell', 'pm', 'path', 'com.recall.voice']).trim();
if (installed) {
  run(['shell', 'am', 'force-stop', 'com.recall.voice']);
  // Current builds are debuggable. If backup is denied, stop instead of wiping/reinstalling.
  const archive = execFileSync(adb, ['-s', serial, 'exec-out', 'run-as', 'com.recall.voice', 'tar', '-cf', '-', '.'], { maxBuffer: 512 * 1024 * 1024 });
  await writeFile(join(root, 'app-private-data.tar'), archive, { flag: 'wx', mode: 0o600 });
  const apkPath = installed.split('\n')[0].replace(/^package:/, '');
  run(['pull', apkPath, join(root, 'previous.apk')]);
}
console.log(run(['install', '-r', join(repo, 'android/app/build/outputs/apk/debug/app-debug.apk')]).trim());
console.log({ backup: root, settingsPreserved: true, backendUrl: 'https://mac-mini-de-samuel.tail431e85.ts.net:8443',
  next: 'Conecta Tailscale en el telefono y cambia Server URL; el token anterior sigue siendo valido.' });
