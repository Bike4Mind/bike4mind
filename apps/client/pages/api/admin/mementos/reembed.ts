import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope, MEMENTO_EMBEDDING_ID } from '@bike4mind/common';
import { Memento } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { reembedMementosForUser } from '@server/memory/reembedMementos';

/**
 * Admin-only, dry-run-by-default repair for V1 mementos left in a pre-pin embedding space (see
 * `mementoEmbeddingIsCurrent` in `@bike4mind/common`, and `getRelevantMementos`'s exclusion gate).
 *
 * Operator loop: POST repeatedly with `{ execute: true }` until the response's `hasMore` is
 * false. No `skip` bookkeeping needed - in execute mode the route always re-queries the head of
 * the still-stale set, since repairing a page removes those users from it. `skip` only matters
 * for a dry-run preview, where nothing is written and the set stays stable across calls.
 */
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

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const { skip, execute } = parsed.data;

  // In execute mode staleWithVectorFilter is self-advancing: repairing a user's mementos removes
  // them from it immediately, so walking a caller-supplied `skip` offset into that shrinking set
  // silently drops roughly half the corpus (each page pushes the next page's start past users the
  // previous page never saw). Execute mode always re-queries the head of the set instead - a
  // retried/failed user simply reappears next call, which is the retry behaviour already wanted.
  // `skip` keeps its ordinary meaning for dry runs, where nothing is written and the set is stable.
  const effectiveSkip = execute ? 0 : skip;

  // reembedMementosForUser repairs one user; enumerating who still needs it is this door's own job.
  const page = await Memento.aggregate<{ _id: string }>([
    { $match: staleWithVectorFilter },
    { $group: { _id: '$userId' } },
    { $sort: { _id: 1 } },
    { $skip: effectiveSkip },
    { $limit: BATCH_SIZE },
  ]);

  if (page.length === 0) {
    return res.json({ processedUsers: 0, dryRun: !execute, hasMore: false, nextSkip: effectiveSkip });
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
    // Always 0 in execute mode - see effectiveSkip above. The caller's loop is simply "keep
    // posting execute:true until hasMore is false", no cursor bookkeeping required.
    nextSkip: execute ? 0 : skip + page.length,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
