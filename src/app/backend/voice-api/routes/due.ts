import { sendJson } from './types';
import type { RouteHandler } from './types';
import { markdownToVoice } from '../markdown-to-voice';
import { Direction } from '@context/study/domain/direction';
import type { DueStudyItemView } from '@context/study/application/study-item-view';

const DEFAULT_LIMIT = 50;

export const handleDue: RouteHandler = async (ctx) => {
  const deckId = ctx.query.get('deckId');
  const limitParam = ctx.query.get('limit');
  const limit = limitParam ? parseInt(limitParam) : DEFAULT_LIMIT;

  const { dailyNewLimit, dailyReviewLimit } = ctx.settings;
  const dailyLimits =
    dailyNewLimit === 0 && dailyReviewLimit === 0
      ? undefined
      : { maxNew: dailyNewLimit, maxReview: dailyReviewLimit };

  const now = new Date();
  let items: DueStudyItemView[];
  if (deckId) {
    items = await ctx.container.getDueStudyItemsByDeck.execute(deckId, now, dailyLimits);
  } else {
    items = await ctx.container.getDueStudyItems.execute(now, dailyLimits);
  }

  // Server-side shuffle (when enabled in settings) so all clients get a
  // consistent randomized order without each having to implement their own.
  // Critical for the mobile app's prefetch — the first N items returned
  // are the actual first N the user will hear.
  if (ctx.settings.shuffleReviews) {
    shuffleInPlace(items);
  }

  if (!isNaN(limit) && limit > 0) {
    items = items.slice(0, limit);
  }

  // Use case already includes `preview` in each view (because the Scheduler
  // is injected into it via the container). Route just adds the voice-friendly
  // text fields — pure presentation concerns specific to this channel.
  const enriched = items.map((it) => {
    const question = it.direction === Direction.AtoB ? it.sideA : it.sideB;
    const answer = it.direction === Direction.AtoB ? it.sideB : it.sideA;
    return {
      ...it,
      voiceQuestion: markdownToVoice(question),
      voiceAnswer: markdownToVoice(answer),
    };
  });

  sendJson(ctx.res, 200, { items: enriched });
};

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
