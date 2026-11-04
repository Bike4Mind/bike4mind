/** One consumer for both kinds: they share a consumer profile and retry policy. Routes on `kind`. */

import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { dispatchWithLogger } from '@bike4mind/server-utils/queueHandlers/utils';
import { emitModalGenerationMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { WhatsNewQueueMessageSchema } from '@bike4mind/server-utils/whatsNew/whatsNewJob.types';
import { runReleaseNotesJob } from './releaseNotes';
import { runHighlightsJob } from './whatsNewHighlights';

/** Bodies from the retired What's New generation cron carry `generatedDate`; they are acked and dropped. */
const isLegacyPayload = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'generatedDate' in body;

export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  logger.updateMetadata({ handler: 'whatsNewJob' });

  for (const record of event.Records) {
    // Invalid JSON throws here on purpose: a corrupt body belongs in the DLQ, not silently acked.
    const body: unknown = JSON.parse(record.body);

    if (isLegacyPayload(body)) {
      logger.warn('[whatsNewJob] dropping legacy whatsNewGeneration payload', { messageId: record.messageId });
      await emitModalGenerationMetrics([{ name: 'LegacyPayloadDropped', value: 1, unit: StandardUnit.Count }]);
      continue;
    }

    const parsed = WhatsNewQueueMessageSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`[whatsNewJob] invalid job payload: ${parsed.error.message}`);
    }
    const message = parsed.data;
    logger.updateMetadata({ kind: message.kind });

    switch (message.kind) {
      case 'release-notes':
        await runReleaseNotesJob(message, logger);
        break;
      case 'highlights':
        await runHighlightsJob(message, logger);
        break;
      default: {
        // Exhaustiveness guard - a new kind must be wired here explicitly.
        const _exhaustive: never = message;
        throw new Error(`Unhandled What's New kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
});
