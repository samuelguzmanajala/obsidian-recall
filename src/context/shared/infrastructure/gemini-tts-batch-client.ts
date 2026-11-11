import { TtsBatchClient, TtsBatchConfig, TtsBatchJob, TtsBatchRejectedError, TtsBatchRequest, TtsBatchResult } from '../domain/tts-batch-client';
import { geminiSpeechRequest, redactor, wavFromResponse } from './gemini-tts-client';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Gemini Batch API with inline requests and inline results (the form verified against
 * gemini-3.8-flash-tts). Results arrive inside the GET response (~400 KB of base64 per clip),
 * so callers keep batches bounded. The JSONL file form (Files API) is not implemented.
 */
export class GeminiTtsBatchClient implements TtsBatchClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly getApiKey: () => string, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async create(displayName: string, requests: TtsBatchRequest[], config: TtsBatchConfig): Promise<{ name: string }> {
    const body = { batch: { displayName, inputConfig: { requests: { requests: requests.map(r => ({
      request: geminiSpeechRequest(r.text, config.voice, config.instructions), metadata: { key: r.key },
    })) } } } };
    const res = await this.call('POST', `models/${encodeURIComponent(config.model)}:batchGenerateContent`, body);
    if (!res.ok) {
      const message = `Gemini batch create rejected (${res.status}): ${res.text.slice(0, 300)}`;
      // A 5xx may have created the job anyway: let the caller treat it as unknown.
      if (res.status >= 500) throw new Error(message);
      throw new TtsBatchRejectedError(message, res.status === 429 || /RESOURCE_EXHAUSTED|quota|enqueued/i.test(res.text));
    }
    const name = res.json?.name;
    if (typeof name !== 'string' || !name.startsWith('batches/')) throw new Error(`Gemini batch create returned no job name: ${res.text.slice(0, 300)}`);
    return { name };
  }

  async get(name: string): Promise<TtsBatchJob> {
    if (!/^batches\/[\w-]+$/.test(name)) throw new Error(`Invalid batch name "${name}"`);
    const res = await this.call('GET', name);
    if (!res.ok) throw new Error(`Gemini batch status failed (${res.status}): ${res.text.slice(0, 300)}`);
    return this.job(res.json);
  }

  async findByDisplayName(displayName: string): Promise<string[]> {
    const names: string[] = [];
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const res = await this.call('GET', `batches?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (!res.ok) throw new Error(`Gemini batch list failed (${res.status}): ${res.text.slice(0, 300)}`);
      const items: any[] = res.json?.operations ?? res.json?.batches ?? [];
      for (const op of items) if ((op?.metadata?.displayName ?? op?.displayName) === displayName && typeof op?.name === 'string') names.push(op.name);
      pageToken = res.json?.nextPageToken ?? '';
      if (!pageToken) break;
    }
    return names;
  }

  private job(op: any): TtsBatchJob {
    const md = op?.metadata ?? {};
    const state = String(md.state ?? 'UNKNOWN');
    const done = op?.done === true || /SUCCEEDED|FAILED|CANCELLED|EXPIRED/.test(state);
    const succeeded = done && /SUCCEEDED/.test(state);
    const job: TtsBatchJob = { name: String(op?.name ?? md.name ?? ''), displayName: md.displayName, state, done, succeeded };
    if (op?.error) job.error = `${op.error.code ?? ''} ${op.error.message ?? JSON.stringify(op.error)}`.trim().slice(0, 300);
    if (!succeeded) return job;
    const list = op?.response?.inlinedResponses?.inlinedResponses ?? md.output?.inlinedResponses?.inlinedResponses;
    if (!Array.isArray(list)) { job.error = 'Batch succeeded but its results are not inline (file output is not supported)'; return job; }
    job.results = list.map((item: any): TtsBatchResult => {
      const key = String(item?.metadata?.key ?? '');
      if (item?.error || !item?.response) return { key, error: `${item?.error?.code ?? ''} ${item?.error?.message ?? 'no response'}`.trim().slice(0, 300) };
      try {
        const usage = item.response.usageMetadata ?? {};
        return { key, wav: wavFromResponse(item.response), promptTokens: Number(usage.promptTokenCount ?? 0), outputTokens: Number(usage.candidatesTokenCount ?? 0) };
      } catch (e) { return { key, error: (e as Error).message.slice(0, 300) }; }
    });
    return job;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const key = this.getApiKey().trim();
    if (!key) throw new Error('Gemini TTS API key not configured.');
    const redact = redactor(key);
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}/${path}`, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError') throw new Error(`Gemini batch request timed out after ${this.timeoutMs / 1000} s`);
      throw new Error(`Gemini batch request failed: ${redact(String((error as Error)?.message ?? error))}`);
    }
    const text = redact(await res.text().catch(() => ''));
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* reported through text */ }
    return { ok: res.ok, status: res.status, text, json };
  }
}
