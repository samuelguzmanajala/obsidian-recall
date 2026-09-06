import { requestUrl, RequestUrlParam } from 'obsidian';

/**
 * A fetch-compatible wrapper around Obsidian's `requestUrl()`.
 * Exists because the renderer's native fetch is blocked by CORS for many
 * external APIs (OpenAI TTS, certain LLM providers, etc.); requestUrl runs
 * in the Electron main/Node context where CORS doesn't apply.
 *
 * Only the surface used by our adapters is implemented — Headers vs plain
 * objects, body as string only, no FormData / streaming.
 */
export const obsidianFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.toString();

  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers;
  if (rawHeaders instanceof Headers) {
    rawHeaders.forEach((value, key) => { headers[key] = value; });
  } else if (Array.isArray(rawHeaders)) {
    for (const [k, v] of rawHeaders) headers[k] = v;
  } else if (rawHeaders) {
    Object.assign(headers, rawHeaders as Record<string, string>);
  }

  let body: string | undefined;
  if (typeof init?.body === 'string') body = init.body;
  else if (init?.body) body = String(init.body);

  const params: RequestUrlParam = {
    url,
    method: init?.method ?? 'GET',
    headers,
    body,
    throw: false, // never throw on 4xx/5xx — let caller inspect status
  };

  const r = await requestUrl(params);

  // requestUrl returns the body once; cache it so .arrayBuffer() and .text()
  // both succeed on our synthetic Response.
  const buf = r.arrayBuffer;
  const responseHeaders: Record<string, string> = (r.headers as Record<string, string>) ?? {};

  return new Response(buf, {
    status: r.status,
    headers: responseHeaders,
  });
};
