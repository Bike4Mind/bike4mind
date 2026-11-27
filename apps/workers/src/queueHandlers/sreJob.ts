/**
 * SRE Job Queue Handler (merged Analysis + Revision)
 *
 * Single consumer for sreJobQueue. The message carries a `jobType` discriminator
 * ('analysis' | 'revision'); this handler validates with SreJobMessageSchema and
 * routes to the shared analysis or revision logic. Analysis and revision share
 * consumer profile (8-min timeout, 1024 MB, Bedrock+CloudWatch) and retry policy
 * (retry 3), so they collapse into one queue.
 *
 * The Fix queue stays separate - it is a downstream dispatch target with a
 * different retry policy, timeout, and permission set.
 */

import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { Resource } from 'sst';
import { createSreQueueAccounting } from './sreQueueAccounting';
import { isSreAccountingError } from '@bike4mind/services/sreAgentService';
import { SreJobMessageSchema } from '@bike4mind/common';
import { runSreAnalysis } from './sreAnalysis';
import { runSreRevision } from './sreRevision';

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  logger.updateMetadata({ handler: 'sreJob' });
  const message = SreJobMessageSchema.parse(JSON.parse(event.Records[0].body));

  const accounting = createSreQueueAccounting(
    event.Records[0],
    Date.now() + context.getRemainingTimeInMillis(),
    Resource.App.stage
  );

  try {
    switch (message.jobType) {
      case 'analysis':
        await runSreAnalysis(message, logger, accounting);
        return;
      case 'revision':
        await runSreRevision(message, logger, accounting);
        return;
      default: {
        const _exhaustive: never = message;
        throw new Error(`Unhandled SRE jobType: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (error) {
    if (isSreAccountingError(error)) {
      logger.error('SRE accounting requires recovery', {
        reason: error.reason,
        providerCallId: error.providerCallId,
        executionId: accounting.attribution.executionId,
      });
    }
    throw error;
  }
});
