import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { Container } from '../container';
import type { RecallSettings } from '../settings';
import { checkAuth } from './auth';
import { handleHealth } from './routes/health';
import { handleDecks } from './routes/decks';
import { handleDue } from './routes/due';
import { handleReviews } from './routes/reviews';
import { handleAudio, type AudioRouteDeps, type AudioSide } from './routes/audio';
import { sendJson, type RouteHandler } from './routes/types';
import type { TtsCache } from './tts-cache';
import type { LlmRewriter } from './llm-rewriter';

const API_PREFIX = '/api/v1';
const MAX_BODY_BYTES = 1_000_000;

interface RouteEntry {
  method: string;
  path: string;
  handler: RouteHandler;
  requiresAuth: boolean;
  expectsBody: boolean;
}

const ROUTES: RouteEntry[] = [
  { method: 'GET', path: '/health', handler: handleHealth, requiresAuth: false, expectsBody: false },
  { method: 'GET', path: '/decks', handler: handleDecks, requiresAuth: true, expectsBody: false },
  { method: 'GET', path: '/due', handler: handleDue, requiresAuth: true, expectsBody: false },
  { method: 'POST', path: '/reviews', handler: handleReviews, requiresAuth: true, expectsBody: true },
];

export interface VoiceApiServerDeps {
  ttsCache: TtsCache | null;
  rewriter: LlmRewriter | null;
  isTtsConfigured: () => boolean;
}

const AUDIO_PATH_RE = /^\/audio\/([^/]+)\/(question|answer)$/;

export class VoiceApiServer {
  private server: Server | null = null;

  constructor(
    private readonly container: Container,
    private readonly settings: RecallSettings,
    private readonly deps: VoiceApiServerDeps = { ttsCache: null, rewriter: null, isTtsConfigured: () => false },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (!this.settings.voiceApi.token) {
      throw new Error('Voice API token not set — generate one in plugin settings.');
    }

    this.server = createServer((req, res) => {
      this.dispatch(req, res).catch((err) => {
        console.error('[Recall API] handler error:', err);
        if (!res.writableEnded) {
          sendJson(res, 500, { error: (err as Error).message });
        }
      });
    });

    const { port, bindAddress } = this.settings.voiceApi;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        reject(err);
      };
      this.server!.once('error', onError);
      this.server!.listen(port, bindAddress, () => {
        this.server!.off('error', onError);
        const addr = this.server!.address() as AddressInfo;
        console.log(`[Recall API] listening on ${addr.address}:${addr.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => {
        console.log('[Recall API] stopped');
        resolve();
      });
    });
  }

  /** Test-only: actual bound port (useful when listening on port 0). */
  getBoundPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const fullPath = url.pathname;

    if (!fullPath.startsWith(API_PREFIX)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const path = fullPath.slice(API_PREFIX.length) || '/';

    // Static-route table first
    const route = ROUTES.find((r) => r.method === req.method && r.path === path);
    if (route) {
      if (route.requiresAuth && !checkAuth(req, this.settings.voiceApi.token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      let body: unknown = null;
      if (route.expectsBody) {
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return;
        }
      }
      await route.handler({
        req,
        res,
        query: url.searchParams,
        body,
        container: this.container,
        settings: this.settings,
      });
      return;
    }

    // Dynamic: GET /audio/<id>/<question|answer>
    const audioMatch = req.method === 'GET' ? AUDIO_PATH_RE.exec(path) : null;
    if (audioMatch) {
      if (!checkAuth(req, this.settings.voiceApi.token)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const [, studyItemId, side] = audioMatch;
      await handleAudio(
        {
          req,
          res,
          query: url.searchParams,
          body: null,
          container: this.container,
          settings: this.settings,
        },
        studyItemId,
        side as AudioSide,
        {
          cache: this.deps.ttsCache,
          rewriter: this.deps.rewriter,
          isTtsConfigured: this.deps.isTtsConfigured,
        } satisfies AudioRouteDeps,
      );
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
