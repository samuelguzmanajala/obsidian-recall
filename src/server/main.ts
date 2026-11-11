import { resolve } from 'node:path';
import { RecallDatabase } from './database';
import { RecallService } from './service';
import { createRecallServer } from './http';
import { configureAudio } from './audio/configure-audio';
import { configureMcp } from './mcp/configure';

const token = process.env.RECALL_TOKEN ?? '';
process.umask(0o077);
if (token.length < 32) throw new Error('Set RECALL_TOKEN to a random secret of at least 32 characters');
const port = Number(process.env.RECALL_PORT ?? 27124);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid RECALL_PORT');
function nonnegative(name: string, fallback: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${name}`);
  return n;
}
const receiptDays = nonnegative('RECALL_RECEIPT_DAYS', 90);
const dbPath = resolve(process.env.RECALL_DB ?? './data/recall.sqlite');
const db = new RecallDatabase(dbPath);
const service = new RecallService(db, {
  flashcardTags: (process.env.RECALL_TAGS ?? '').split(',').map(t => t.trim()).filter(Boolean),
  dailyNewLimit: nonnegative('RECALL_DAILY_NEW', 20),
  dailyReviewLimit: nonnegative('RECALL_DAILY_REVIEW', 0),
  leechThreshold: nonnegative('RECALL_LEECH_THRESHOLD', 8),
  shuffleReviews: process.env.RECALL_SHUFFLE !== 'false',
});
const server = createRecallServer(service, token, configureAudio());
const mcp = configureMcp(process.env, dbPath, service, token);
const expire = () => service.expireReceipts(receiptDays).catch(error => console.error('Receipt expiry failed:', error));
void expire();
const expiry = setInterval(expire, 86_400_000);
expiry.unref();
service.reindexIfTagsChanged().then(() => {
  if (stopping) return;
  server.listen(port, process.env.RECALL_HOST ?? '127.0.0.1', () => {
    console.log(`Recall backend listening on ${process.env.RECALL_HOST ?? '127.0.0.1'}:${port}`);
  });
  mcp?.listen();
}).catch(async error => { console.error('Recall startup failed:', error); clearInterval(expiry); await db.close(); process.exitCode = 1; });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(expiry);
  server.closeIdleConnections();
  await new Promise<void>(r => server.close(() => r()));
  await mcp?.close();
  await db.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
