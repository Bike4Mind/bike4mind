import { apiCompletionObservationSchema, COMPLETION_SEQUENCE_SCAN_LIMIT } from '@bike4mind/common';
import { ApiKeyUsageLog } from './ApiKeyUsageLogModel';
import { User } from './UserModel';

/** Scans retained terminal request logs; older metadata is explicitly incomplete coverage. */
export async function loadCompletionSynchronyEvents(now: Date) {
  const from = new Date(now.getTime() - 24 * 3_600_000);
  const rows = await ApiKeyUsageLog.find({ endpoint: '/api/ai/v1/completions', timestamp: { $gte: from, $lt: now } })
    .select('_id userId completionObservation')
    .sort({ timestamp: -1 })
    .limit(COMPLETION_SEQUENCE_SCAN_LIMIT + 1)
    .maxTimeMS(10_000)
    .lean();
  const kept = rows.slice(0, COMPLETION_SEQUENCE_SCAN_LIMIT);
  const ids = [...new Set(kept.map(row => row.userId))].filter(id => /^[a-f0-9]{24}$/i.test(id));
  const accounts = await User.find({
    _id: { $in: ids.slice(0, 1_000) },
    deletedAt: null,
    'deletion.purgeStartedAt': null,
    isBanned: { $ne: true },
  })
    .select('_id')
    .maxTimeMS(10_000)
    .lean();
  const live = new Set(accounts.map(account => String(account._id)));
  let legacyRows = 0;
  const events = kept.flatMap(row => {
    const parsed = apiCompletionObservationSchema.safeParse(row.completionObservation);
    if (!parsed.success) {
      legacyRows++;
      return [];
    }
    const observation = parsed.data;
    const at = new Date(observation.startedAt);
    if (at < from || at >= now) return [];
    return [
      {
        eventId: String(row._id),
        userId: row.userId,
        at,
        requestedModel: observation.requestedModel,
        outcome: observation.outcome,
        eligible: live.has(row.userId),
      },
    ];
  });
  return {
    events,
    rowsScanned: kept.length,
    accountsScanned: accounts.length,
    legacyRows,
    truncated: rows.length > COMPLETION_SEQUENCE_SCAN_LIMIT || ids.length > 1_000,
  };
}
