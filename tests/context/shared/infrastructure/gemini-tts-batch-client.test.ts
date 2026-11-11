import { describe, it, expect, vi } from 'vitest';
import { GeminiTtsBatchClient } from '@context/shared/infrastructure/gemini-tts-batch-client';
import { pcmToWav } from '@context/shared/infrastructure/gemini-tts-client';
import { TtsBatchRejectedError } from '@context/shared/domain/tts-batch-client';

const KEY = 'AIza-batch-secret';
const WAV = pcmToWav(Buffer.alloc(48000));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (fetchImpl: ReturnType<typeof vi.fn>) => new GeminiTtsBatchClient(() => KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });
const config = { model: 'gemini-3.8-flash-tts', voice: 'Kore' };

/** Shape captured from a real gemini-3.8-flash-tts batch (audio shortened). */
const finished = {
  name: 'batches/abc123', done: true,
  metadata: { '@type': 'type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatch', displayName: 'recall-tts-x',
    state: 'BATCH_STATE_SUCCEEDED', batchStats: { requestCount: '2', successfulRequestCount: '1', failedRequestCount: '1' } },
  response: { '@type': 'type.googleapis.com/google.ai.generativelanguage.v1main.GenerateContentBatchOutput', inlinedResponses: { inlinedResponses: [
    { response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: WAV.toString('base64') } }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 172, totalTokenCount: 196 } }, metadata: { key: 'k1' } },
    { error: { code: 3, message: 'Invalid voice' }, metadata: { key: 'k2' } },
  ] } },
};

describe('GeminiTtsBatchClient', () => {
  it('creates an inline-requests batch with the verified body shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ name: 'batches/abc123', metadata: { state: 'BATCH_STATE_PENDING' } }));
    expect(await client(fetchImpl).create('recall-tts-x', [{ key: 'k1', text: 'hola' }], { ...config, instructions: 'calm' })).toEqual({ name: 'batches/abc123' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:batchGenerateContent');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({ batch: { displayName: 'recall-tts-x', inputConfig: { requests: { requests: [{
      request: { contents: [{ role: 'user', parts: [{ text: 'hola', speech_metadata: { style: 'calm' } }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: 'Kore' } } } },
      metadata: { key: 'k1' },
    }] } } } });
  });

  it('classifies create failures: quota rejection, other rejection, ambiguous 5xx; never leaks the key', async () => {
    const quota = vi.fn().mockResolvedValue(json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: `enqueued tokens exceeded ${KEY}` } }, 429));
    const err = await client(quota).create('d', [{ key: 'k', text: 't' }], config).catch(e => e);
    expect(err).toBeInstanceOf(TtsBatchRejectedError);
    expect(err.quota).toBe(true);
    expect(err.message).not.toContain(KEY);
    const bad = await client(vi.fn().mockResolvedValue(json({ error: { message: 'bad' } }, 400))).create('d', [], config).catch(e => e);
    expect(bad).toBeInstanceOf(TtsBatchRejectedError);
    expect(bad.quota).toBe(false);
    const ambiguous = await client(vi.fn().mockResolvedValue(json({}, 503))).create('d', [], config).catch(e => e);
    expect(ambiguous).not.toBeInstanceOf(TtsBatchRejectedError);
    const network = await client(vi.fn().mockRejectedValue(new Error(`socket ${KEY}`))).create('d', [], config).catch(e => e);
    expect(network).not.toBeInstanceOf(TtsBatchRejectedError);
    expect(network.message).not.toContain(KEY);
  });

  it('reads a pending job and the results of a finished one, including per-request errors', async () => {
    const pending = await client(vi.fn().mockResolvedValue(json({ name: 'batches/abc123', metadata: { state: 'BATCH_STATE_RUNNING' } }))).get('batches/abc123');
    expect(pending).toMatchObject({ state: 'BATCH_STATE_RUNNING', done: false, succeeded: false });
    const fetchImpl = vi.fn().mockResolvedValue(json(finished));
    const job = await client(fetchImpl).get('batches/abc123');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/batches/abc123');
    expect(job).toMatchObject({ done: true, succeeded: true, displayName: 'recall-tts-x' });
    expect(job.results![0]).toMatchObject({ key: 'k1', promptTokens: 24, outputTokens: 172 });
    expect((job.results![0] as { wav: Buffer }).wav.equals(WAV)).toBe(true);
    expect(job.results![1]).toEqual({ key: 'k2', error: '3 Invalid voice' });
  });

  it('reports a failed job and refuses invalid names', async () => {
    const job = await client(vi.fn().mockResolvedValue(json({ name: 'batches/x', done: true, error: { code: 13, message: 'internal' }, metadata: { state: 'BATCH_STATE_FAILED' } }))).get('batches/x');
    expect(job).toMatchObject({ done: true, succeeded: false, error: '13 internal' });
    await expect(client(vi.fn()).get('../models')).rejects.toThrow(/Invalid batch name/);
  });

  it('finds jobs by display name across pages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ operations: [{ name: 'batches/a', metadata: { displayName: 'other' } }], nextPageToken: 'p2' }))
      .mockResolvedValueOnce(json({ operations: [{ name: 'batches/b', metadata: { displayName: 'mine' } }] }));
    expect(await client(fetchImpl).findByDisplayName('mine')).toEqual(['batches/b']);
    expect(fetchImpl.mock.calls[1][0]).toContain('pageToken=p2');
  });
});
