import {
  lakeConfigSnapshotExpiresAt,
  type ILakeConfigSnapshot,
  type ILakeConfigSnapshotRepository,
} from '@bike4mind/common';
import type { LakeConfigAuditLogger } from './resolveLakeConfigAuditRetention';
import { Logger } from '@bike4mind/observability';

export interface LakeConfigSnapshotAdapters {
  db: { lakeConfigSnapshots: Pick<ILakeConfigSnapshotRepository, 'record'> };
  logger?: LakeConfigAuditLogger;
}

export type LakeConfigSnapshotInput = Omit<ILakeConfigSnapshot, 'eventId' | 'expiresAt'>;

/**
 * Store the full values behind a History row, BEST-EFFORT like the row itself and like the file
 * removal record: the change has already landed, so a failed write is logged and swallowed rather
 * than reported as a failed change. The cost is that undo of that one change refuses.
 *
 * A null `eventId` means the History row was not written, so there is nothing to key the snapshot
 * to and nothing is stored.
 */
export async function recordLakeConfigSnapshot(
  eventId: string | null,
  snapshot: LakeConfigSnapshotInput,
  { db, logger }: LakeConfigSnapshotAdapters,
  now: Date = new Date()
): Promise<void> {
  if (!eventId) return;
  try {
    await db.lakeConfigSnapshots.record({ ...snapshot, eventId, expiresAt: lakeConfigSnapshotExpiresAt(now) });
  } catch (err) {
    const meta = { dataLakeId: snapshot.dataLakeId, eventId, kind: snapshot.kind, err };
    const msg = '[dataLakes] lake config changed but its undo snapshot did not persist';
    if (logger?.warn) logger.warn(msg, meta);
    else Logger.warn(msg, meta);
  }
}
