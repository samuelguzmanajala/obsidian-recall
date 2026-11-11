import { mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RecallDatabase } from './database';
import { RecallService } from './service';
import { configureAudio } from './audio/configure-audio';
import { StopError, dryRun, listOrphans, runBatch, runInteractive, type PregenerateDeps, type PregenerateOptions } from './audio/pregenerate-audio';
import { GeminiTtsBatchClient } from '../context/shared/infrastructure/gemini-tts-batch-client';
import { redactor, wavSeconds } from '../context/shared/infrastructure/gemini-tts-client';
import { assertFfmpegUsable, ffmpegWavToMp3 } from '../context/shared/infrastructure/ffmpeg-audio-converter';

export const HELP = `Usage: node --env-file=<backend.env> dist/server/pregenerate.cjs [options]

Pregenerates the remote-voice MP3 cache with the same texts and file names that
GET /api/v1/audio serves. Uses the server's RECALL_* variables; opens RECALL_DB read-only.

  --dry-run              Counts and estimated cost; no TTS or LLM calls (default)
  --apply                Generate (requires --max-usd)
  --max-usd=X            Spend cap for this run, estimated + real (USD)
  --mode=batch|interactive
                         Default: batch with RECALL_TTS_PROVIDER=gemini, else interactive
  --limit=N              Only the first N missing texts (trials)
  --batch-size=N         Texts per batch job (default 500)
  --concurrency=N        Parallel interactive calls and rewrites (default 2)
  --wait-minutes=N       Wait for one batch job at most N minutes, then leave it for a
                         re-run of the same command (default 60)
  --discard-unconfirmed  Forget an interrupted submission that the provider does not list
  --orphans              List cache MP3 files no current card side uses (deletes nothing)
  --orphans-out=FILE     With --orphans: also write their paths to FILE
  --help                 This text`;

export interface CliArgs extends PregenerateOptions { orphans: boolean; orphansOut?: string; help: boolean }

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new StopError(`${name} must be a positive integer`);
  return n;
}

export function parseArgs(argv: string[], provider: string): CliArgs {
  const args: CliArgs = { apply: false, mode: provider === 'gemini' ? 'batch' : 'interactive', batchSize: 500, concurrency: 2,
    waitMinutes: 60, discardUnconfirmed: false, orphans: false, help: false };
  let dry = false;
  for (const arg of argv) {
    const [flag, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const need = () => { if (value === undefined || value === '') throw new StopError(`${flag} needs a value (${flag}=…)`); return value; };
    switch (flag) {
      case '--dry-run': dry = true; break;
      case '--apply': args.apply = true; break;
      case '--orphans': args.orphans = true; break;
      case '--help': case '-h': args.help = true; break;
      case '--discard-unconfirmed': args.discardUnconfirmed = true; break;
      case '--mode': {
        const mode = need();
        if (mode !== 'batch' && mode !== 'interactive') throw new StopError('--mode must be batch or interactive');
        args.mode = mode; break;
      }
      case '--limit': args.limit = positiveInt(flag, need()); break;
      case '--batch-size': args.batchSize = positiveInt(flag, need()); break;
      case '--concurrency': args.concurrency = positiveInt(flag, need()); break;
      case '--wait-minutes': args.waitMinutes = positiveInt(flag, need()); break;
      case '--orphans-out': args.orphansOut = resolve(need()); break;
      case '--max-usd': {
        const n = Number(need());
        if (!Number.isFinite(n) || n <= 0) throw new StopError('--max-usd must be a positive number');
        args.maxUsd = n; break;
      }
      default: throw new StopError(`Unknown option ${arg} (see --help)`);
    }
  }
  if (dry && args.apply) throw new StopError('--dry-run and --apply exclude each other');
  if (args.orphans && args.apply) throw new StopError('--orphans only lists files; do not combine it with --apply');
  if (args.apply && args.maxUsd === undefined) throw new StopError('--apply requires --max-usd=X (a spend cap in USD)');
  if (args.apply && args.mode === 'batch' && provider !== 'gemini') throw new StopError('--mode=batch needs RECALL_TTS_PROVIDER=gemini');
  return args;
}

/** One pregeneration process per audio directory: two would submit the same work. */
async function lock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'pregenerate.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const handle = await open(path, 'r');
      const pid = Number(await handle.readFile('utf8'));
      await handle.close();
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch { /* not running */ }
      if (alive) throw new StopError(`Another pregeneration (pid ${pid}) is running on ${dir}`);
      await rm(path, { force: true });
    }
  }
  throw new StopError(`Cannot take ${path}`);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void): Promise<number> {
  const redact = redactor(env.RECALL_TTS_KEY?.trim() ?? '');
  const say = (line: string) => out(redact(line));
  let db: RecallDatabase | undefined;
  let unlock: (() => Promise<void>) | undefined;
  try {
    const provider = env.RECALL_TTS_PROVIDER ?? 'openai';
    const args = parseArgs(argv, provider);
    if (args.help) { out(HELP); return 0; }
    if (!env.RECALL_TTS_KEY) throw new StopError('RECALL_TTS_KEY is not set: the server would not generate remote audio');
    let measured = 0;
    const ffmpeg = env.RECALL_FFMPEG || 'ffmpeg';
    if (provider === 'gemini' && args.apply) assertFfmpegUsable(ffmpeg);
    const toMp3 = ffmpegWavToMp3(ffmpeg);
    const audio = configureAudio(env, {
      convert: async wav => { const mp3 = await toMp3(wav); measured += wavSeconds(wav); return mp3; },
      // Pregeneration has time: honour longer 429 delays than the phone could.
      gemini: { maxAttempts: 6, maxTotalMs: 300_000, timeoutMs: 60_000 },
    })!;
    const dbPath = resolve(env.RECALL_DB ?? './data/recall.sqlite');
    db = new RecallDatabase(dbPath, { readOnly: true });
    say(`Database: ${dbPath} (read-only)`);
    say(`Audio directory: ${audio.cache.cacheDir}`);
    const deps: PregenerateDeps = {
      service: new RecallService(db), audio, out: say,
      // Only Gemini audio passes through the converter; OpenAI costs are estimated from the text.
      measuredSeconds: provider === 'gemini' ? () => measured : undefined,
      batch: provider === 'gemini' ? new GeminiTtsBatchClient(() => env.RECALL_TTS_KEY ?? '') : undefined,
    };
    if (args.orphans) { await listOrphans(deps, args.orphansOut); return 0; }
    if (!args.apply) { say('Mode: dry run (default)'); await dryRun(deps); return 0; }
    unlock = await lock(audio.cache.cacheDir);
    say(`Mode: apply, ${args.mode}, cap $${args.maxUsd}${args.limit ? `, limit ${args.limit}` : ''}`);
    const summary = args.mode === 'batch' ? await runBatch(deps, args) : await runInteractive(deps, args);
    return summary.pending ? 3 : summary.stopped ? 2 : 0;
  } catch (error) {
    say(`${error instanceof StopError ? 'Stopped' : 'Error'}: ${(error as Error)?.message ?? error}`);
    return 1;
  } finally {
    await unlock?.();
    await db?.close();
  }
}

if (require.main === module) {
  process.umask(0o077);
  main(process.argv.slice(2), process.env, line => console.log(line)).then(code => { process.exitCode = code; });
}
