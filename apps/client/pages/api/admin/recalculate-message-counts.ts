import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sessionRepository } from '@bike4mind/database/auth';
import { ForbiddenError } from '@server/utils/errors';
import { SpiderEvents } from '@server/utils/eventBus';
import { v4 as uuidv4 } from 'uuid';
import { assertSessionOperationalCredits } from '@server/utils/sessionOperationalCreditPreflight';
import { HTTPError } from '@bike4mind/common';

type SpiderOperation = 'messageCount' | 'curation' | 'summarize' | 'tags' | 'embeddings';

/**
 * The spider operations whose handlers settle through `recordSessionOperationalUsage`, and so are
 * the ones a credit pre-flight can size, each mapped to the count of notebooks it should be
 * charged for. The other three record no operational usage at all: `messageCount` is a pure
 * recount, `curation` publishes to a handler with no billing path, and the spider generates
 * embeddings inline without recording usage. Typed against the operation union so a renamed
 * member fails the build rather than silently costing nothing.
 *
 * Both legs narrow past "every notebook", but not the same way, because the two handlers abort on
 * different things:
 *
 * - `summarize` keeps a plain `summaryAt: null` count. Its only content-dependent return
 *   (`server/events/sessionSummarization.ts`, after the model resolve and before the completion;
 *   the four returns above it are argument and existence guards a counted notebook cannot hit)
 *   also requires `!needsInitialSummaryId`, and the only writer of `summaryModelId` sets it in
 *   the same update as `summaryAt` - so a notebook this leg
 *   counts normally has no model id either, falls through, and settles even when it is empty. The
 *   one way to hold a model id without a `summaryAt` is an import overwrite, which nulls
 *   `summaryAt` and leaves the id (notebookImportService); such a notebook can return early only
 *   if the imported file also carried no chat history. Not narrowed for: that population is tiny,
 *   and the effect is the same harmless direction described below.
 * - `tags` cannot use `taggedAt: null` alone. `server/events/sessionTagging.ts` aborts before the
 *   model when the notebook has no quest AND writes nothing, so such a notebook is dispatched,
 *   counted, and re-counted on every run while settling nothing.
 *   `countTaggableNotebooks` adds the quest-existence term that mirrors that gate.
 *
 * What remains is a gap this pre-flight cannot close: it prices DISPATCHES, and a dispatch is not
 * a settlement. A notebook whose completion never parses is charged at most once per
 * `TAG_RETRY_BACKOFF_MS` window (`isTagAttemptDue` gates the dispatch, `tagAttemptDueFilter` the
 * count above) - bounded per window, but deliberately uncapped over time, because a terminal cap
 * would strand a notebook no automated path can reopen. One that gains its first quest between
 * this count and the spider's pass settles without having been counted.
 * `assertSessionOperationalCredits` only gates and never debits (see its docstring), so neither
 * moves a balance - they only shift the refusal threshold.
 */
const SPENDING_SPIDER_OPERATIONS = {
  summarize: (userId: string) =>
    sessionRepository.count({
      userId,
      $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
      // `null` matches missing-or-null, which is what the handler's `!session.summaryAt` accepts.
      summaryAt: null,
    }),
  tags: (userId: string) => sessionRepository.countTaggableNotebooks(userId),
} as const satisfies Partial<Record<SpiderOperation, (userId: string) => Promise<number>>>;

type SpendingSpiderOperation = keyof typeof SPENDING_SPIDER_OPERATIONS;

const isSpendingSpiderOperation = (operation: SpiderOperation): operation is SpendingSpiderOperation =>
  operation in SPENDING_SPIDER_OPERATIONS;

/**
 * Admin endpoint to trigger Spider job for comprehensive notebook grooming
 * Uses EventBus pattern to avoid Lambda timeout limits
 *
 * Operations performed:
 * - Recalculate message counts
 * - Trigger curation for uncurated notebooks
 * - Trigger summarization for unsummarized notebooks
 * - Trigger tagging for untagged notebooks
 *
 * Query parameters:
 * - dryRun: boolean (default: false) - If true, only simulates the job without making changes
 * - operations: string[] (default: all) - Specific operations to run
 */
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    // Only admins can trigger Spider
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    try {
      const userId = req.user.id;
      const query = req.query as Record<string, string | string[] | undefined>;
      const body = req.body as { dryRun?: boolean; operations?: SpiderOperation[] } | undefined;
      const dryRun = query.dryRun === 'true' || body?.dryRun === true;
      const requestedOperations: SpiderOperation[] =
        body?.operations || (['messageCount', 'curation', 'summarize', 'tags'] as const); // embeddings not included by default

      const totalNotebooks = await sessionRepository.count({
        userId,
        $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }],
      });

      console.log(
        `[Admin] Starting Spider job for user ${userId} with ${totalNotebooks} notebooks${dryRun ? ' (DRY RUN)' : ''}`
      );

      // Admin-gated is not credit-gated (#1852): the spider fans summarize/tag out across every
      // notebook this user owns, so an ungated run is the largest operational spend on the
      // platform. Skipped on a dry run, which returns the plan and never reaches the publishes
      // at all (spider.ts:317-320 returns before them), so it spends nothing to gate.
      if (!dryRun) {
        // Sized to the work the handler will actually do, not to `totalNotebooks`: it skips an
        // already-groomed notebook per operation, so pricing a re-run at notebooks x operations
        // would refuse an 800-notebook account 1600 credits for the five notebooks left to do.
        // Deduped because the requested list is caller-supplied and a repeat would double-count.
        // See SPENDING_SPIDER_OPERATIONS for what each leg counts and why they differ.
        const ungroomedCounts = await Promise.all(
          Array.from(new Set(requestedOperations))
            .filter(isSpendingSpiderOperation)
            .map(operation => SPENDING_SPIDER_OPERATIONS[operation](userId))
        );

        await assertSessionOperationalCredits({
          userId,
          requesterId: userId,
          operationCount: ungroomedCounts.reduce((total, count) => total + count, 0),
          operation: 'notebook grooming',
          logger: req.logger,
        });
      }

      const spiderJobId = uuidv4();

      // Publish Spider start event - the event handler will process asynchronously
      await SpiderEvents.Start.publish({
        spiderJobId,
        userId,
        totalNotebooks,
        operations: requestedOperations,
        dryRun,
      });

      return res.json({
        success: true,
        message: `Spider job ${dryRun ? '(DRY RUN) ' : ''}started for ${totalNotebooks} notebooks`,
        spiderJobId,
        totalNotebooks,
        dryRun,
        operations: requestedOperations,
      });
    } catch (error) {
      // A credit refusal is a billing state, not a spider failure: let the shared error handler
      // render its 422 and `insufficient_credits` tag rather than flattening both into the
      // generic 500 below, which would read to the caller as a bug.
      if (error instanceof HTTPError) throw error;
      console.error('[Admin] Error starting Spider job:', error);
      return res.status(500).json({
        error: 'Failed to start Spider job',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
