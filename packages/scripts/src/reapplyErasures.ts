import { writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AdminAuditLogModel, User, erasureRecordRepository, type IErasureRecord } from '@bike4mind/database';
import { erasureIdHash, erasureKeyId, erasurePseudonym } from '@bike4mind/server-utils/privacy/erasureHash';
import { reapplyErasure } from '@server/users/reapplyErasure';

type Log = (message: string) => void;
const noop: Log = () => undefined;

export const erasureRecordSchema = z.object({
  idHash: z.string().min(1),
  keyId: z.string().min(1),
  pseudonym: z.string().nullable(),
  erasedAt: z.coerce.date(),
  initiatedBy: z.enum(['admin', 'self', 'backfill']),
});

/** An export is the trust boundary: validate it rather than trusting the file. */
export const parseErasureExport = (json: string): IErasureRecord[] =>
  z.array(erasureRecordSchema).parse(JSON.parse(json));

export async function exportErasureRecords(records: AsyncIterable<IErasureRecord>, file: string): Promise<number> {
  const all: IErasureRecord[] = [];
  for await (const r of records) all.push({ ...r });
  await writeFile(file, JSON.stringify(all, null, 2));
  return all.length;
}

export interface ReapplyErasuresOptions {
  /** Erasure records from a source that outlived the restore (pre-restore cluster or an export). */
  records: AsyncIterable<IErasureRecord> | Iterable<IErasureRecord>;
  dryRun: boolean;
  /** Users scanned per query. */
  batchSize?: number;
  log?: Log;
}

export interface ReapplyErasuresResult {
  scanned: number;
  /** Users present in the target database whose id hash has an erasure record. */
  matched: number;
  /** Matches re-erased; 0 in a dry run. */
  reapplied: number;
  failed: number;
  /** Records hashed under a different key than the current one (a rotated JWT_SECRET): cannot be matched. */
  unmatchableKey: number;
}

/** Label for output: the pseudonym when one was recorded, else a hash prefix. Never a raw id. */
const label = (r: IErasureRecord) => r.pseudonym?.slice(0, 12) ?? `hash:${r.idHash.slice(0, 12)}`;

/**
 * Re-erase every account in the target database that an erasure record says was erased. Pages users
 * by _id, hashes each id and looks it up among the records. Idempotent: once an account is gone it no
 * longer matches, so a re-run does nothing. A dry run only counts and labels.
 */
export async function reapplyErasures({
  records,
  dryRun,
  batchSize = 500,
  log = noop,
}: ReapplyErasuresOptions): Promise<ReapplyErasuresResult> {
  const currentKeyId = erasureKeyId();
  const byHash = new Map<string, IErasureRecord>();
  const result: ReapplyErasuresResult = { scanned: 0, matched: 0, reapplied: 0, failed: 0, unmatchableKey: 0 };
  for await (const record of records) {
    if (record.keyId === currentKeyId) byHash.set(record.idHash, record);
    else result.unmatchableKey += 1;
  }
  if (result.unmatchableKey) {
    log(`WARNING: ${result.unmatchableKey} record(s) were hashed under another key and cannot be matched`);
  }

  let after: mongoose.Types.ObjectId | undefined;
  while (true) {
    const batch = await User.collection
      .find(after ? { _id: { $gt: after } } : {}, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (batch.length === 0) break;
    after = batch[batch.length - 1]._id as mongoose.Types.ObjectId;
    for (const row of batch) {
      result.scanned += 1;
      const userId = String(row._id);
      const record = byHash.get(erasureIdHash(userId));
      if (!record) continue;
      result.matched += 1;
      if (dryRun) {
        log(`would re-erase ${label(record)} (erased ${record.erasedAt.toISOString()}, ${record.initiatedBy})`);
        continue;
      }
      try {
        await reapplyErasure(userId, {
          initiatedBy: record.initiatedBy,
          logger: { info: noop, warn: log, error: log },
        });
        result.reapplied += 1;
        log(`re-erased ${label(record)}`);
      } catch (error) {
        result.failed += 1;
        log(`FAILED ${label(record)}: ${error instanceof Error ? error.name : 'error'}`);
      }
    }
  }
  return result;
}

const AUDIT_ERASURE_ACTIONS = { 'user.deleted': 'admin', 'user.deletion.completed': 'self' } as const;

export interface BackfillResult {
  /** Audit entries naming a user who no longer exists. */
  candidates: number;
  /** Records newly written; 0 in a dry run. */
  created: number;
}

/**
 * Build erasure records for accounts erased before records existed, from the admin audit entries of
 * the two erasure paths. Skips a target that still has a user row (not erased, or already restored).
 * Accounts erased through no audited path cannot be found.
 */
export async function backfillErasureRecords({
  dryRun,
  log = noop,
}: {
  dryRun: boolean;
  log?: Log;
}): Promise<BackfillResult> {
  const keyId = erasureKeyId();
  const found = new Map<string, IErasureRecord>();
  const cursor = AdminAuditLogModel.find({
    action: { $in: Object.keys(AUDIT_ERASURE_ACTIONS) },
    'target.kind': 'user',
  })
    .select({ action: 1, occurredAt: 1, 'target.id': 1 })
    .lean()
    .cursor();
  for await (const entry of cursor) {
    const targetId = entry.target.id;
    if (!mongoose.isValidObjectId(targetId) || (await User.exists({ _id: targetId }))) continue;
    const idHash = erasureIdHash(targetId);
    if (found.has(idHash)) continue;
    found.set(idHash, {
      idHash,
      keyId,
      pseudonym: erasurePseudonym(targetId),
      erasedAt: entry.occurredAt,
      initiatedBy: AUDIT_ERASURE_ACTIONS[entry.action as keyof typeof AUDIT_ERASURE_ACTIONS],
    });
  }
  const candidates = [...found.values()];
  log(`${candidates.length} erased account(s) found in the audit log`);
  const created = dryRun ? 0 : await erasureRecordRepository.importMany(candidates);
  return { candidates: candidates.length, created };
}
