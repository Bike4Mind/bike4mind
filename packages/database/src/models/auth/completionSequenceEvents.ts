import { COMPLETION_SEQUENCE_SCAN_LIMIT, COMPLETION_SEQUENCE_WINDOW_HOURS } from '@bike4mind/common';
import { UsageEvent } from '../billing/UsageEventModel';
import { User } from './UserModel';

const MAX_ACCOUNTS = 1_000;
const QUERY_MS = 10_000;

/** Existing successful API-completion settlements only; no prompts, models, keys or network data. */
export async function loadCompletionSequenceEvents(now: Date) {
  const rows = await UsageEvent.find({
    feature: 'completion_api',
    status: 'ok',
    createdAt: { $gte: new Date(now.getTime() - COMPLETION_SEQUENCE_WINDOW_HOURS * 3_600_000), $lt: now },
  })
    .select('userId requestId createdAt')
    .sort({ createdAt: -1 })
    .limit(COMPLETION_SEQUENCE_SCAN_LIMIT + 1)
    .maxTimeMS(QUERY_MS)
    .lean();
  const kept = rows.slice(0, COMPLETION_SEQUENCE_SCAN_LIMIT);
  const ids = [...new Set(kept.map(row => row.userId))].filter(id => /^[a-f0-9]{24}$/i.test(id));
  const accounts = await User.find({
    _id: { $in: ids.slice(0, MAX_ACCOUNTS) },
    deletedAt: null,
    isBanned: { $ne: true },
    'deletion.purgeStartedAt': null,
  })
    .select('_id')
    .limit(MAX_ACCOUNTS)
    .maxTimeMS(QUERY_MS)
    .lean();
  const liveIds = new Set(accounts.map(account => String(account._id)));
  return {
    // Excluded accounts stay as barriers, so removing them cannot manufacture adjacent runs.
    events: kept.map(row => ({
      userId: row.userId,
      requestId: row.requestId,
      at: row.createdAt,
      eligible: liveIds.has(row.userId),
    })),
    rowsScanned: kept.length,
    accountsScanned: accounts.length,
    truncated: rows.length > COMPLETION_SEQUENCE_SCAN_LIMIT || ids.length > MAX_ACCOUNTS,
  };
}
