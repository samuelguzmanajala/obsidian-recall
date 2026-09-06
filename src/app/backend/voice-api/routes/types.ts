import type { IncomingMessage, ServerResponse } from 'http';
import type { Container } from '../../container';
import type { RecallSettings } from '../../settings';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  body: unknown;
  container: Container;
  settings: RecallSettings;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload).toString());
  res.end(payload);
}
