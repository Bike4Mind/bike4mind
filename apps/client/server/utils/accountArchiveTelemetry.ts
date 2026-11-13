import { Quest } from '@bike4mind/database';
import { regenerateUserTelemetryHashes } from './telemetryHashLookup';
import { TELEMETRY_EXPORT_PROJECTION } from './telemetryProjection';

/** The caller must authorize the account owner before invoking this collector. */
export async function collectAccountTelemetry(userId: string) {
  if (!userId) throw new Error('Account id is required');
  const hashes = await regenerateUserTelemetryHashes(userId);
  const records = await Quest.find({
    'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: hashes },
  })
    .select(TELEMETRY_EXPORT_PROJECTION)
    .lean();

  return records
    .filter(record => record.promptMeta?.contextTelemetry)
    .map(record => ({
      timestamp: record.timestamp?.toISOString() ?? '',
      telemetry: record.promptMeta!.contextTelemetry,
    }));
}
