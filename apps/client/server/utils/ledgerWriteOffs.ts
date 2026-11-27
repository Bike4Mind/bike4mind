import { Types } from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';
import { CreditTransaction, UsageEvent } from '@bike4mind/database';

/**
 * A capped chat turn whose cost exceeded what the balance could pay writes its ledger row at the full
 * cost, but the balance only moved by what was collected; the rest is recorded as writtenOffCredits on
 * the turn's UsageEvent (ChatCompletionProcess settlement). Every admin view that rebuilds a balance or
 * totals spend from the ledger has to take the write-off back out, or it reports credits nobody paid.
 * This module pairs each write-off with its ledger row so those views can.
 */

/** Most write-offs read per user; they happen only on capped turns, so this is far above any real account. */
const MAX_WRITE_OFFS = 2000;
const QUERY_MAX_TIME_MS = 15_000;
/** A turn's ledger row lands within seconds of its usage event; the window only bounds the index scan. */
const PAIRING_WINDOW_MS = 60 * 60 * 1000;

export type LedgerWriteOff = {
  transactionId: string;
  createdAt: Date;
  writtenOffCredits: number;
  model?: string;
  source?: string;
};

export type LedgerWriteOffs = {
  byTransactionId: ReadonlyMap<string, LedgerWriteOff>;
  all: readonly LedgerWriteOff[];
};

export const NO_WRITE_OFFS: LedgerWriteOffs = { byTransactionId: new Map(), all: [] };

type WriteOffEventRow = { requestId: string; creditsCharged: number; writtenOffCredits: number; createdAt: Date };
type UsageLedgerRow = {
  _id: Types.ObjectId;
  questId?: string;
  credits: number;
  createdAt: Date;
  model?: string;
  source?: string;
};

/**
 * Pairs write-off events with ledger rows nearest in time, with the same quest and gross credits.
 * Each row and event is used once, so a quest with several settlements (a retry) still pairs one to one.
 */
export const pairWriteOffs = (
  events: readonly WriteOffEventRow[],
  ledgerRows: readonly UsageLedgerRow[]
): LedgerWriteOff[] => {
  const unpaired = new Map<string, UsageLedgerRow[]>();
  for (const row of ledgerRows) {
    if (!row.questId) continue;
    const key = `${row.questId}|${Math.abs(row.credits)}`;
    unpaired.set(key, [...(unpaired.get(key) ?? []), row]);
  }
  const paired: LedgerWriteOff[] = [];
  for (const event of events) {
    const candidates = unpaired.get(`${event.requestId}|${Math.abs(event.creditsCharged)}`);
    candidates?.sort((a, b) => {
      const aTime = a.createdAt.getTime();
      const bTime = b.createdAt.getTime();
      return (
        Math.abs(aTime - event.createdAt.getTime()) - Math.abs(bTime - event.createdAt.getTime()) ||
        aTime - bTime ||
        a._id.toHexString().localeCompare(b._id.toHexString())
      );
    });
    const row = candidates?.shift();
    if (!row) continue;
    paired.push({
      transactionId: row._id.toHexString(),
      createdAt: row.createdAt,
      // Never more than the row itself: a write-off cannot turn a charge into a credit.
      writtenOffCredits: Math.min(event.writtenOffCredits, Math.abs(row.credits)),
      model: row.model || undefined,
      source: row.source || undefined,
    });
  }
  return paired;
};

/** Every write-off on the user's own balance, paired with its ledger row. Org-billed turns are not this user's ledger. */
export async function loadLedgerWriteOffs(ownerId: string): Promise<LedgerWriteOffs> {
  const events = await UsageEvent.find({
    ownerId,
    ownerType: CreditHolderType.User,
    feature: 'chat',
    writtenOffCredits: { $gt: 0 },
  })
    .select('requestId creditsCharged writtenOffCredits createdAt')
    .sort({ createdAt: -1 })
    .limit(MAX_WRITE_OFFS)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<WriteOffEventRow[]>();
  if (events.length === 0) return NO_WRITE_OFFS;

  const times = events.map(event => event.createdAt.getTime());
  const ledgerRows = await CreditTransaction.find({
    ownerId,
    ownerType: CreditHolderType.User,
    type: 'text_generation_usage',
    questId: { $in: [...new Set(events.map(event => event.requestId))] },
    createdAt: {
      $gte: new Date(Math.min(...times) - PAIRING_WINDOW_MS),
      $lte: new Date(Math.max(...times) + PAIRING_WINDOW_MS),
    },
  })
    .select('_id questId credits createdAt model source')
    .sort({ createdAt: -1, _id: -1 })
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<UsageLedgerRow[]>();

  const all = pairWriteOffs(events, ledgerRows);
  return { byTransactionId: new Map(all.map(writeOff => [writeOff.transactionId, writeOff])), all };
}

/** Credits written off on ledger rows strictly newer than `position` in {createdAt, _id} order. */
export const writtenOffNewerThan = (writeOffs: LedgerWriteOffs, position: { createdAt: Date; id: string }): number =>
  writeOffs.all.reduce((sum, writeOff) => {
    const byTime = writeOff.createdAt.getTime() - position.createdAt.getTime();
    const newer = byTime > 0 || (byTime === 0 && writeOff.transactionId > position.id);
    return newer ? sum + writeOff.writtenOffCredits : sum;
  }, 0);

/** Credits written off on ledger rows at or after `since`. */
export const writtenOffSince = (writeOffs: LedgerWriteOffs, since: Date): number =>
  writeOffs.all.reduce(
    (sum, writeOff) => (writeOff.createdAt.getTime() >= since.getTime() ? sum + writeOff.writtenOffCredits : sum),
    0
  );

/** Adds each write-off back to its UTC day's net ledger delta ('YYYY-MM-DD' keys), for days at or after `from`. */
export const dailyNetWithWriteOffs = (
  dailyNet: ReadonlyArray<{ day: string; netCredits: number }>,
  writeOffs: LedgerWriteOffs,
  from: Date
): Array<{ day: string; netCredits: number }> => {
  const byDay = new Map(dailyNet.map(({ day, netCredits }) => [day, netCredits]));
  for (const writeOff of writeOffs.all) {
    if (writeOff.createdAt.getTime() < from.getTime()) continue;
    const day = writeOff.createdAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + writeOff.writtenOffCredits);
  }
  return [...byDay].map(([day, netCredits]) => ({ day, netCredits }));
};
