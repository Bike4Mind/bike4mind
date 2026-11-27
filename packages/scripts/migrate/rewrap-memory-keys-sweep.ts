import type { mongo } from 'mongoose';
import { decryptFact, openWrappedDek, wrapDekUnder } from '@bike4mind/server-utils/memory/factCipher';

export type SweepMode = 'rewrite' | 'dry-run' | 'verify';

export interface MemoryKeySweep {
  scanned: number;
  /** Wrapped under the current master key. */
  alreadyCurrent: number;
  rewrapped: number;
  /** Dry-run only: rows a run would rewrap. */
  wouldRewrap: number;
  /** Wrapped under neither key (in verify mode: not under the current key). */
  openedByNeither: number;
  /** Destroyed principals: no data key to move. */
  tombstones: number;
  /** Stored unwrapped (`raw:` or unprefixed); needs migrate:protect-credentials first. */
  raw: number;
  /** Erased or re-minted between the read and the write, so left alone. */
  changedDuringWrite: number;
  /** Verify only: principals whose newest encrypted fact was decrypted with the stored key. */
  factsChecked: number;
  factsUnreadable: number;
  principalsWithoutFacts: number;
}

export interface MemoryKeys {
  current: Buffer;
  previous?: Buffer;
}

interface KeyRow {
  _id: mongo.ObjectId;
  dek?: string;
  principalKind?: string;
  principalId?: string;
  destroyedAt?: Date;
}

type RowOutcome = 'tombstone' | 'raw' | 'current' | 'wouldRewrap' | 'rewrapped' | 'changed' | 'neither';

const isEnc = (dek: string): boolean => dek.startsWith('enc:');

/**
 * Classifies one key row and, in rewrite mode, moves it from the previous key to the current one.
 * The write is conditional on the exact `dek` that was read, so a row erased (tombstoned) or
 * re-minted since the read is never overwritten.
 */
export async function rewrapRow(
  collection: mongo.Collection<KeyRow>,
  row: KeyRow,
  keys: MemoryKeys,
  mode: SweepMode
): Promise<RowOutcome> {
  if (!row.dek) return 'tombstone';
  if (!isEnc(row.dek)) return 'raw';
  if (openWrappedDek(row.dek, [keys.current])) return 'current';
  if (mode === 'verify' || !keys.previous) return 'neither';
  const opened = openWrappedDek(row.dek, [keys.previous]);
  if (!opened) return 'neither';
  const rewrapped = wrapDekUnder(keys.current, opened.dek);
  // Never write a value the current key cannot open back to the same data key.
  if (!openWrappedDek(rewrapped, [keys.current])?.dek.equals(opened.dek)) return 'neither';
  if (mode === 'dry-run') return 'wouldRewrap';
  // update-validators-off: native driver write of one field, conditional on the exact value read
  const result = await collection.updateOne({ _id: row._id, dek: row.dek }, { $set: { dek: rewrapped } });
  return result.modifiedCount === 1 ? 'rewrapped' : 'changed';
}

const emptySweep = (): MemoryKeySweep => ({
  scanned: 0,
  alreadyCurrent: 0,
  rewrapped: 0,
  wouldRewrap: 0,
  openedByNeither: 0,
  tombstones: 0,
  raw: 0,
  changedDuringWrite: 0,
  factsChecked: 0,
  factsUnreadable: 0,
  principalsWithoutFacts: 0,
});

/** Decrypts the newest stored fact of the principal with its (current-key) data key. */
async function checkFact(db: mongo.Db, row: KeyRow, current: Buffer, counts: MemoryKeySweep): Promise<void> {
  const dek = openWrappedDek(row.dek!, [current])!.dek;
  const event = await db.collection('memoryledgerevents').findOne(
    {
      principalKind: row.principalKind,
      principalId: row.principalId,
      factCipher: { $type: 'string' },
      ...(row.destroyedAt ? { createdAt: { $gt: row.destroyedAt } } : {}),
    },
    // Facts from a previous key incarnation cannot verify the reminted key.
    { sort: { seq: -1 }, projection: { factCipher: 1, factIv: 1, factTag: 1 } }
  );
  if (!event) {
    counts.principalsWithoutFacts++;
    return;
  }
  counts.factsChecked++;
  const fact = decryptFact(dek, { cipher: event.factCipher, iv: event.factIv ?? '', tag: event.factTag ?? '' });
  if (fact === null) counts.factsUnreadable++;
}

/**
 * Walks every memory principal key once through the raw driver (no hooks, no timestamp changes).
 * The initial raw-key census stops a rewrite before writes. Raw keys found later are reported
 * alongside completed rewraps; they need migrate:protect-credentials before a retry.
 */
export async function sweepMemoryKeys(db: mongo.Db, keys: MemoryKeys, mode: SweepMode): Promise<MemoryKeySweep> {
  const collection = db.collection<KeyRow>('memoryprincipalkeys');
  const counts = emptySweep();

  const rawBeforeWalk = await collection.countDocuments({ dek: { $type: 'string', $ne: '', $not: /^enc:/ } });
  if (rawBeforeWalk > 0 && mode !== 'verify') {
    counts.raw = rawBeforeWalk;
    return counts;
  }

  for await (const row of collection.find(
    {},
    { projection: { dek: 1, principalKind: 1, principalId: 1, destroyedAt: 1 } }
  )) {
    counts.scanned++;
    const outcome = await rewrapRow(collection, row, keys, mode);
    if (outcome === 'raw') counts.raw++;
    else if (outcome === 'tombstone') counts.tombstones++;
    else if (outcome === 'current') {
      counts.alreadyCurrent++;
      if (mode === 'verify') await checkFact(db, row, keys.current, counts);
    } else if (outcome === 'wouldRewrap') counts.wouldRewrap++;
    else if (outcome === 'rewrapped') counts.rewrapped++;
    else if (outcome === 'changed') counts.changedDuringWrite++;
    else if (outcome === 'neither') counts.openedByNeither++;
  }
  return counts;
}

/**
 * 2 while rows are stored unwrapped (report and stop), 1 while any row is unreadable, left for
 * another run, or (verify) not under the current key, else 0. An empty collection is 0: a fresh
 * stage legitimately has no keys.
 */
export const sweepExitCode = (counts: MemoryKeySweep): 0 | 1 | 2 =>
  counts.raw > 0
    ? 2
    : counts.openedByNeither + counts.changedDuringWrite + counts.factsUnreadable + counts.wouldRewrap > 0
      ? 1
      : 0;

/** Counts only: no key row id and no stored value is ever printed. */
export function formatSweep(counts: MemoryKeySweep, mode: SweepMode): string {
  const lines = [
    `scanned=${counts.scanned}  tombstones=${counts.tombstones}  already-current=${counts.alreadyCurrent}`,
  ];
  if (mode === 'verify') {
    lines.push(
      `not-under-current=${counts.openedByNeither}  facts-checked=${counts.factsChecked}  ` +
        `facts-unreadable=${counts.factsUnreadable}  principals-without-facts=${counts.principalsWithoutFacts}`
    );
  } else {
    const moved = mode === 'dry-run' ? `would-rewrap=${counts.wouldRewrap}` : `rewrapped=${counts.rewrapped}`;
    lines.push(
      `${moved}  changed-during-write=${counts.changedDuringWrite}  opened-by-neither=${counts.openedByNeither}`
    );
  }
  if (counts.raw > 0) {
    lines.push(
      `raw=${counts.raw}  (stored unwrapped: run migrate:protect-credentials first${mode === 'verify' || counts.rewrapped > 0 ? '' : '; nothing was written'})`
    );
  }
  if (counts.scanned === 0 && counts.raw === 0)
    lines.push('No memory principal keys found (fresh stage or empty database).');
  return lines.join('\n');
}
