import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { Memento } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { MEMENTO_EMBEDDING_ID } from '@bike4mind/common';
import { reembedMementosForUser } from '@server/memory/reembedMementos';

const BATCH_SIZE = 25;

const bodySchema = z.object({
  skip: z.number().int().nonnegative().default(0),
  // Defaults to a dry run: reembedMementosForUser makes a provider call per stale memento, so a
  // caller must opt in to spending before the pass writes anything.
  execute: z.boolean().default(false),
});

// A memento is stale for this pass only if it both carries a vector AND that vector is not in the
// pinned space - an un-embedded memento has nothing to repair, and re-running excludes what the
// previous pass already fixed (embeddingModel: MEMENTO_EMBEDDING_ID).
const staleWithVectorFilter = {
  embeddingModel: { $ne: MEMENTO_EMBEDDING_ID },
  'embedding.0': { $exists: true },
};

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const { skip, execute } = parsed.data;

  // reembedMementosForUser repairs one user; enumerating who still needs it is this door's own job.
  const page = await Memento.aggregate<{ _id: string }>([
    { $match: staleWithVectorFilter },
    { $group: { _id: '$userId' } },
    { $sort: { _id: 1 } },
    { $skip: skip },
    { $limit: BATCH_SIZE },
  ]);

  if (page.length === 0) {
    return res.json({ processedUsers: 0, dryRun: !execute, hasMore: false, nextSkip: skip });
  }

  const totals = { total: 0, alreadyCurrent: 0, reembedded: 0, failed: 0, skippedEmpty: 0 };
  const failedUsers: Array<{ userId: string; error: string }> = [];

  for (const { _id: userId } of page) {
    try {
      const stats = await reembedMementosForUser(userId, { dryRun: !execute });
      totals.total += stats.total;
      totals.alreadyCurrent += stats.alreadyCurrent;
      totals.reembedded += stats.reembedded;
      totals.failed += stats.failed;
      totals.skippedEmpty += stats.skippedEmpty;
    } catch (err) {
      // One user with no resolvable credential (reembedMementosForUser throws before its own
      // per-memento try/catch can run) must not abort the rest of the page.
      failedUsers.push({ userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return res.json({
    processedUsers: page.length,
    dryRun: !execute,
    ...totals,
    failedUsers,
    hasMore: page.length === BATCH_SIZE,
    nextSkip: skip + page.length,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
