import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { emitModalGenerationMetrics } from '@server/utils/cloudwatch';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import {
  ReleaseNotesConfigSchema,
  ReleaseNotesJobPayloadSchema,
  type ReleaseNotesConfig,
  type ReleaseNotesJobPayload,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const SETTING_NAME = 'releaseNotesConfig';

/** Bodies from the retired What's New generation cron carry `generatedDate`; they are acked and dropped. */
const isLegacyPayload = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'generatedDate' in body;

async function loadConfig(logger: Logger): Promise<ReleaseNotesConfig | null> {
  const settings = await getSettingsByNames([SETTING_NAME], { adminSettings: adminSettingsRepository }, { logger });
  const raw: unknown = settings[SETTING_NAME];
  let value: unknown = raw ?? {};
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  const parsed = ReleaseNotesConfigSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn(`[releaseNotes] ${SETTING_NAME} is malformed; treating as disabled`, { issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

async function processPayload(payload: ReleaseNotesJobPayload, logger: Logger): Promise<void> {
  logger.updateMetadata({ releaseTag: payload.releaseTag });

  const config = await loadConfig(logger);
  if (!config?.enabled) {
    logger.info(`[releaseNotes] ${SETTING_NAME} is disabled; skipping ${payload.releaseTag}`);
    return;
  }

  // Throwing sends the message to the DLQ, where it can be replayed once generation ships.
  throw new Error(`[releaseNotes] generation not wired yet for ${payload.releaseTag}`);
}

export const dispatch = dispatchWithLogger(async (event, _context, logger) => {
  for (const record of event.Records) {
    // Invalid JSON throws here on purpose: a corrupt body belongs in the DLQ, not silently acked.
    const body: unknown = JSON.parse(record.body);

    if (isLegacyPayload(body)) {
      logger.warn('[releaseNotes] dropping legacy whatsNewGeneration payload', { messageId: record.messageId });
      await emitModalGenerationMetrics([{ name: 'LegacyPayloadDropped', value: 1, unit: StandardUnit.Count }]);
      continue;
    }

    const parsed = ReleaseNotesJobPayloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`[releaseNotes] invalid job payload: ${parsed.error.message}`);
    }

    await processPayload(parsed.data, logger);
  }
});
