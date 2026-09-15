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

import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { SreJobMessageSchema } from '@bike4mind/common';
import { runSreAnalysis } from '@server/queueHandlers/sreAnalysis';
import { runSreRevision } from '@server/queueHandlers/sreRevision';

export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  logger.updateMetadata({ handler: 'sreJob' });
  const message = SreJobMessageSchema.parse(JSON.parse(event.Records[0].body));

  switch (message.jobType) {
    case 'analysis':
      await runSreAnalysis(message, logger);
      return;
    case 'revision':
      await runSreRevision(message, logger);
      return;
    default: {
      // Exhaustiveness guard - a new jobType must be wired here explicitly.
      const _exhaustive: never = message;
      throw new Error(`Unhandled SRE jobType: ${JSON.stringify(_exhaustive)}`);
    }
  }
});
