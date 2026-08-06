import { FabFile, Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Audit (read-only): FabFiles whose sessionId points at a session owned by a different user.
 *
 * The session summarizer has always created a summary FabFile with session.userId as its
 * owner (sessionSummarization.ts). Before that summarizer's own-file lookup was scoped to the
 * session owner too, re-summarizing a notebook could overwrite a FabFile it did not own,
 * leaving that file's userId disagreeing with its own sessionId's owner - and that lookup
 * being unscoped is not the only way to get here: PUT /api/files/[id] lets a caller hand-stamp
 * any sessionId onto their own file with no check that they own the session it now claims to
 * belong to.
 *
 * This migration only counts and logs; it does not decide anything, because "re-point",
 * "delete", or "notify the affected owner" all depend on the actual row and cannot be chosen
 * generically. It runs automatically on every deploy (see updateDatabase in
 * apps/client/server/utils/manageDatabase.ts), so the real count for a given stage shows up in
 * that deploy's logs.
 *
 * Idempotent: a second run finds the same rows (nothing here is mutated) and logs the same count.
 */

type FabFileLean = {
  _id: unknown;
  userId: string;
  sessionId: string;
  fileName: string;
  createdAt?: Date | null;
};

export type OwnerMismatch = {
  fabFileId: string;
  sessionId: string;
  fabFileUserId: string;
  sessionUserId: string;
  fileName: string;
  createdAt: Date | null;
};

export type MismatchScan = {
  mismatches: OwnerMismatch[];
  orphanedSessionIds: string[];
};

/**
 * Exported so the classification is testable without a database. A sessionId with no matching
 * Session doc is tracked separately, not as a mismatch: the issue's definition ("userId differs
 * from that session's userId") has no session to compare against in that case.
 */
export const findOwnerMismatches = (fabFiles: FabFileLean[], sessionOwnerById: Map<string, string>): MismatchScan => {
  const mismatches: OwnerMismatch[] = [];
  const orphanedSessionIds = new Set<string>();

  for (const file of fabFiles) {
    const sessionUserId = sessionOwnerById.get(file.sessionId);
    if (sessionUserId === undefined) {
      orphanedSessionIds.add(file.sessionId);
      continue;
    }
    if (sessionUserId !== file.userId) {
      mismatches.push({
        fabFileId: String(file._id),
        sessionId: file.sessionId,
        fabFileUserId: file.userId,
        sessionUserId,
        fileName: file.fileName,
        createdAt: file.createdAt ?? null,
      });
    }
  }

  return { mismatches, orphanedSessionIds: [...orphanedSessionIds] };
};

const migration: MigrationFile = {
  id: 20260806000000,
  name: 'audit-fabfile-session-owner-mismatch',

  up: async () => {
    const fabFiles = (await FabFile.find({ deletedAt: null, sessionId: { $exists: true, $nin: [null, ''] } })
      .select('userId sessionId fileName createdAt')
      .lean()) as unknown as FabFileLean[];

    if (fabFiles.length === 0) {
      console.log('[audit-fabfile-session-owner-mismatch] no FabFiles carry a sessionId, nothing to audit');
      return;
    }

    const sessionIds = [...new Set(fabFiles.map(f => f.sessionId))];
    // includeDeleted: a session's recorded owner does not change because the session was later
    // soft-deleted, and a mismatch predating that deletion is exactly as real.
    const sessions = (await Session.find({ _id: { $in: sessionIds } })
      .select('userId')
      .setOptions({ includeDeleted: true })
      .lean()) as unknown as { _id: unknown; userId: string }[];
    const sessionOwnerById = new Map(sessions.map(s => [String(s._id), s.userId]));

    const { mismatches, orphanedSessionIds } = findOwnerMismatches(fabFiles, sessionOwnerById);

    console.log(
      `[audit-fabfile-session-owner-mismatch] scanned ${fabFiles.length} FabFile(s) with a sessionId, found ${mismatches.length} owner mismatch(es)`
    );
    for (const mismatch of mismatches) {
      console.log(`[audit-fabfile-session-owner-mismatch] mismatch ${JSON.stringify(mismatch)}`);
    }

    if (orphanedSessionIds.length > 0) {
      console.log(
        `[audit-fabfile-session-owner-mismatch] ${orphanedSessionIds.length} sessionId(s) with no matching Session doc, not counted above: ${JSON.stringify(orphanedSessionIds)}`
      );
    }
  },

  // Read-only: nothing is written, so there is nothing to revert.
  down: async () => {},
};

export default migration;
