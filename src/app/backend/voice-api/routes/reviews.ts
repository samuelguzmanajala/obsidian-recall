import { sendJson } from './types';
import type { RouteHandler } from './types';
import { Rating } from '@context/study/domain/rating';

interface ReviewInput {
  studyItemId?: unknown;
  rating?: unknown;
}

const VALID_RATINGS = new Set<string>(Object.values(Rating));

export const handleReviews: RouteHandler = async (ctx) => {
  const body = ctx.body as { reviews?: unknown } | null;
  if (!body || !Array.isArray(body.reviews)) {
    sendJson(ctx.res, 400, { error: 'expected body { reviews: [...] }' });
    return;
  }

  const errors: { idx: number; reason: string }[] = [];
  let applied = 0;

  for (let i = 0; i < body.reviews.length; i++) {
    const r = body.reviews[i] as ReviewInput;
    if (typeof r?.studyItemId !== 'string' || typeof r?.rating !== 'string') {
      errors.push({ idx: i, reason: 'malformed review entry' });
      continue;
    }
    if (!VALID_RATINGS.has(r.rating)) {
      errors.push({ idx: i, reason: `unknown rating: ${r.rating}` });
      continue;
    }
    try {
      await ctx.container.reviewStudyItem.execute({
        studyItemId: r.studyItemId,
        rating: r.rating as Rating,
      });
      applied++;
    } catch (err) {
      errors.push({ idx: i, reason: (err as Error).message });
    }
  }

  sendJson(ctx.res, 200, { applied, errors });
};
