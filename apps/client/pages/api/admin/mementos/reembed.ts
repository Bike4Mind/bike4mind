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
 * false. A single call is bounded by MAX_MEMENTOS_PER_REQUEST as well as by BATCH_SIZE, so a page
 * can come back truncated with users left unwalked; `hasMore` covers both cases. No `skip` bookkeeping needed - in execute mode the route always re-queries the head of
 * the still-stale set, since repairing a page removes those users from it. `skip` only matters
 * for a dry-run preview, where nothing is written and the set stays stable across calls.
 *
 * Convergence depends on every page eventually making progress. A user who can never be repaired
 * (see `staleWithVectorFilter`'s summary condition for the one case excluded at the query level)
 * would otherwise sit at the head of the sort order forever and block every user behind them,
 * since execute mode always re-queries skip=0 - see `hasMore` below for the other half of this.
 */
const BATCH_SIZE = 25;

// Ceiling on provider calls per request, and the companion BATCH_SIZE needs: that one caps USERS,
// which bounds nothing, because a single user's stale set is unbounded. The edge cuts an origin
// response at 60s while this route embeds one memento at a time, so an uncapped page times out
// there and keeps writing at the origin - the caller cannot distinguish that from a failure and
// gets no totals back either way. Measured at 3-5 mementos/sec against the live corpus, so 100
// lands around 20-35s with room for a slow provider. A page cut short reports hasMore: true and
// the operator loop simply calls again; execute mode already re-queries the head of the set, so
// there is no cursor to keep.
const MAX_MEMENTOS_PER_REQUEST = 100;

// failedMementos is a diagnostic sample, not a ledger: `failed` carries the true count, so the
// omitted number is always `failed - failedMementos.length`. Capped because it has one entry per
// failed MEMENTO rather than per user - a provider outage during a page of 25 users with a few
// hundred stale mementos each would otherwise put thousands of strings in one response.
const MAX_REPORTED_MEMENTO_FAILURES = 50;

const bodySchema = z.object({
  skip: z.number().int().nonnegative().default(0),
  // Defaults to a dry run: reembedMementosForUser makes a provider call per stale memento, so a
  // caller must opt in to spending before the pass writes anything.
  execute: z.boolean().default(false),
});

// Unicode whitespace set that JS's String.prototype.trim() strips (the ECMA-262 WhiteSpace and
// LineTerminator productions). Spelled out as literal code points rather than \s/\S: MongoDB's regex
// engine treats \S as "not ASCII whitespace", so a summary of nothing but NBSP or another Unicode
// space character MATCHES \S there while .trim() below renders it empty - the query would then admit
// a memento reembedMementosForUser can never repair, which is exactly the permanent blocker this
// filter exists to keep out. Verified against a real mongod that this class agrees with .trim()
// truthiness on every case in this set, ASCII and Unicode alike.
const JS_TRIM_WHITESPACE =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

// A memento is stale for this pass only if it both carries a vector AND that vector is not in the
// pinned space - an un-embedded memento has nothing to repair, and re-running excludes what the
// previous pass already fixed (embeddingModel: MEMENTO_EMBEDDING_ID). The summary condition mirrors
// reembedMementosForUser's own `!memento.summary?.trim()` skip: a blank summary can never be
// repaired by this route no matter how many times it's retried, so counting it as "stale" here
// would pin its user at the head of the sort order permanently once execute mode always re-queries
// skip=0 (see the docblock above).
const staleWithVectorFilter = {
  embeddingModel: { $ne: MEMENTO_EMBEDDING_ID },
  'embedding.0': { $exists: true },
  summary: { $regex: `[^${JS_TRIM_WHITESPACE}]` },
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

  // Declared before the empty-page exit below so BOTH returns answer the same shape. Kept as two
  // hand-written field lists they drift, and the drift bites at the worst moment: a caller tracking
  // progress as `total - alreadyCurrent` throws on the missing key exactly when the pass succeeds
  // and the stale set finally empties, which reads as a crash rather than as completion.
  const totals = { total: 0, alreadyCurrent: 0, reembedded: 0, failed: 0, skippedEmpty: 0 };
  const failedUsers: Array<{ userId: string; error: string }> = [];
  const failedMementos: string[] = [];

  // reembedMementosForUser repairs one user; enumerating who still needs it is this door's own job.
  const page = await Memento.aggregate<{ _id: string }>([
    { $match: staleWithVectorFilter },
    { $group: { _id: '$userId' } },
    { $sort: { _id: 1 } },
    { $skip: effectiveSkip },
    { $limit: BATCH_SIZE },
  ]);

  if (page.length === 0) {
    return res.json({
      processedUsers: 0,
      dryRun: !execute,
      ...totals,
      failedUsers,
      failedMementos,
      hasMore: false,
      nextSkip: effectiveSkip,
    });
  }

  // Provider calls already spent by this request, against MAX_MEMENTOS_PER_REQUEST. Counted from
  // the stats rather than tracked inside the service so one ceiling covers the whole page: users
  // are walked sequentially, so a budget applied per user would multiply by the page size.
  let spent = 0;
  let truncated = false;
  let processedUsers = 0;

  for (const { _id: userId } of page) {
    if (execute && spent >= MAX_MEMENTOS_PER_REQUEST) {
      truncated = true;
      break;
    }
    processedUsers += 1;
    try {
      // A dry run makes no provider call, so the ceiling is inert there and the preview still
      // reports the whole page.
      const stats = await reembedMementosForUser(userId, {
        dryRun: !execute,
        limit: MAX_MEMENTOS_PER_REQUEST - spent,
      });
      totals.total += stats.total;
      totals.alreadyCurrent += stats.alreadyCurrent;
      totals.reembedded += stats.reembedded;
      totals.failed += stats.failed;
      totals.skippedEmpty += stats.skippedEmpty;
      spent += stats.reembedded + stats.failed;
      if (stats.stoppedAtLimit) truncated = true;
      for (const error of stats.errors) {
        if (failedMementos.length >= MAX_REPORTED_MEMENTO_FAILURES) break;
        failedMementos.push(`user ${userId} ${error}`);
      }
    } catch (err) {
      // One user with no resolvable credential (reembedMementosForUser throws before its own
      // per-memento try/catch can run) must not abort the rest of the page.
      failedUsers.push({ userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // The remaining ways a user can fail (no resolvable credential, a transient provider error) can't
  // be excluded at the query level - they're worth retrying. But since execute mode always re-queries
  // skip=0, a page that reembeds nothing would otherwise repeat identically forever: same users, same
  // failures, no way for the loop to ever reach whoever sorts behind them. Progress is measured
  // against the QUERIED set specifically (a stale-but-unembedded memento can leave it via
  // reembedMementosForUser without this filter ever having seen it), not the repairable set in
  // general - a page only counts as "more to do" if it actually shrank what THIS filter re-queries.
  // A fully-stuck page stops the loop here instead, with failedUsers naming who needs a credential
  // fixed and failed/failedMementos showing how many mementos failed and a sample of which.
  const pageMadeProgress = execute ? totals.reembedded > 0 : true;

  return res.json({
    // What this request actually walked, which is below page.length when the provider-call ceiling
    // cut it short - reporting the queried page size there would claim work that never ran.
    processedUsers,
    dryRun: !execute,
    ...totals,
    failedUsers,
    failedMementos,
    // Two independent reasons there is more to do: the page filled BATCH_SIZE users, or the
    // provider-call ceiling truncated it. Without the second a truncated page reports false (it is
    // not a full page of users) and the operator loop stops with work left. Both stay gated on real
    // progress, so a page whose every call failed still ends the loop rather than re-queueing the
    // same failures forever - see pageMadeProgress above.
    hasMore: pageMadeProgress && (truncated || page.length === BATCH_SIZE),
    // Always 0 in execute mode - see effectiveSkip above. The caller's loop is simply "keep
    // posting execute:true until hasMore is false", no cursor bookkeeping required.
    nextSkip: execute ? 0 : skip + processedUsers,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
