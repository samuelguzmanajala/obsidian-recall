import { sendJson } from './types';
import type { RouteHandler } from './types';

export const handleHealth: RouteHandler = async (ctx) => {
  sendJson(ctx.res, 200, { status: 'ok' });
};
