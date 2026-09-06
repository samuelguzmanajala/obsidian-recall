import { sendJson } from './types';
import type { RouteHandler } from './types';

export const handleDecks: RouteHandler = async (ctx) => {
  const tree = await ctx.container.getDeckTree.execute();
  sendJson(ctx.res, 200, { decks: tree });
};
