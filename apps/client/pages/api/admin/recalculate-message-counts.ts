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
 * the ones a credit pre-flight can size. `messageCount` is a pure recount; `curation` and
 * `embeddings` run through their own handlers and billing paths. Typed against the operation
 * union so a renamed or misspelled member fails the build rather than silently costing nothing.
 */
const SPENDING_SPIDER_OPERATIONS: ReadonlySet<SpiderOperation> = new Set<SpiderOperation>([
  'summarize',
  'tags',
]);

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
      // platform. Sized to the operations that actually settle through recordOperationalUsage -
      // messageCount does no model call, embeddings and curation bill through their own paths.
      // Skipped on a dry run, which publishes the same events but performs no model calls.
      const billableOperationCount =
        totalNotebooks * requestedOperations.filter(operation => SPENDING_SPIDER_OPERATIONS.has(operation)).length;
      if (!dryRun) {
        await assertSessionOperationalCredits({
          userId,
          operationCount: billableOperationCount,
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
