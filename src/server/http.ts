import { createServer, type IncomingMessage } from 'node:http';
import { checkAuth } from './auth';
import { sendJson } from './send-json';
import { ApiError, RecallService, dueLimit, record, string } from './service';
import { createHash } from 'node:crypto';
import type { ServerAudio } from './audio/configure-audio';
import { preprocessForTts } from './audio/preprocess-text';

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > 2_100_000) {
    req.resume();
    throw new ApiError(413, 'Request too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_100_000) throw new ApiError(413, 'Request too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}

export function createRecallServer(service: RecallService, token: string, audio?: ServerAudio) {
  if (token.length < 32) throw new Error('RECALL_TOKEN must contain at least 32 characters');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/v1/health') {
        sendJson(res, 200, { ok: true, service: 'recall-backend', protocol: 2 }); return;
      }
      if (!checkAuth(req, token)) throw new ApiError(401, 'Unauthorized');
      let result: unknown;
      if (req.method === 'GET' && path === '/api/v1/decks') {
        result = await service.query(async c => ({ decks: await c.getDeckTree.execute() }));
      } else if (req.method === 'GET' && path === '/api/v1/stats') {
        result = await service.query(c => c.getStudyStats.execute());
      } else if (req.method === 'GET' && path === '/api/v1/leeches') {
        result = await service.query(c => c.getLeeches.execute(service.settings.leechThreshold));
      } else if (req.method === 'GET' && path === '/api/v1/due') {
        const limit = dueLimit(Number(url.searchParams.get('limit') ?? 50));
        result = await service.due(url.searchParams.get('deckId') ?? undefined, limit);
      } else if (req.method === 'GET' && path === '/api/v1/sources') {
        result = await service.query(c => c.sources.snapshot());
      } else if (req.method === 'GET' && path === '/api/v1/notes') {
        result = await service.notes();
      } else if (req.method === 'GET' && path === '/api/v1/note') {
        result = await service.db.transaction(async () => {
          const row = service.db.sql.prepare('SELECT path,content,revision FROM notes WHERE path=?').get(url.searchParams.get('path') ?? '');
          if (!row) throw new ApiError(404, 'Note not found');
          return row;
        });
      } else if (req.method === 'POST' && path === '/api/v1/notes') {
        result = await service.note(await readBody(req));
      } else if (req.method === 'POST' && path === '/api/v1/notes/rename') {
        result = await service.renameNote(await readBody(req));
      } else if (req.method === 'POST' && path === '/api/v1/reviews') {
        const body = record(await readBody(req));
        if (!Array.isArray(body.reviews) || body.reviews.length < 1 || body.reviews.length > 100) throw new ApiError(400, 'Expected 1–100 reviews');
        const due = body.due === undefined ? undefined : record(body.due);
        const queue = due && { deckId: due.deckId === undefined ? undefined : string(due.deckId, 'deckId'), limit: dueLimit(due.limit) };
        let applied = 0;
        const errors: { idx: number; reason: string; status: number }[] = [];
        for (const [idx, review] of body.reviews.entries()) {
          try { await service.review(review); applied++; }
          catch (e) {
            if (!(e instanceof ApiError)) throw e;
            errors.push({ idx, reason: e.message, status: e.status });
          }
        }
        // The queue is recomputed on every call (also on retries); it is not part of the review receipt.
        result = queue ? { applied, errors, due: await service.due(queue.deckId, queue.limit) } : { applied, errors };
      } else if (req.method === 'GET' && /^\/api\/v1\/audio\//.test(path)) {
        const match = /^\/api\/v1\/audio\/([^/]+)\/(question|answer)$/.exec(path);
        if (!match) throw new ApiError(404, 'Not found');
        if (!audio) throw new ApiError(503, 'Remote TTS is not enabled; use device TTS');
        const text = preprocessForTts(await service.audioText(match[1], match[2] as 'question' | 'answer'));
        if (!text) throw new ApiError(422, 'Empty audio text');
        // External requests happen AFTER the database transaction has committed.
        const rewritten = audio.rewriter ? await audio.rewriter.rewrite(text) : text;
        let data: Buffer;
        try {
          data = await audio.cache.getOrGenerate(createHash('sha256').update(match[1]).digest('hex'), match[2] === 'question' ? 'q' : 'a', rewritten);
        } catch (e) {
          console.error('[Recall backend] speech generation failed:', (e as Error)?.message ?? e);
          throw new ApiError(502, 'Speech generation failed; use device TTS');
        }
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', data.length);
        res.end(data); return;
      } else throw new ApiError(404, 'Not found');
      sendJson(res, 200, result);
    } catch (e) {
      if (!(e instanceof ApiError)) console.error('[Recall backend]', e);
      if (!res.headersSent && !res.destroyed) sendJson(res, e instanceof ApiError ? e.status : 500,
        { error: e instanceof ApiError ? e.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
