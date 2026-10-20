import type { Types } from 'mongoose';
import type { AdminAuditAction, AuditChange } from '@bike4mind/common';
import { AdminAuditLogModel, CreditTransaction } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[backfill-admin-audit-credits]';
const BATCH_SIZE = 500;

// Every action that moves credits; each must carry a signed numeric details.credits.
export const CREDIT_MOVING_ACTIONS = [
  'user.credits.adjusted',
  'user.subscription.granted',
  'org.credits.granted',
  'org.credits.topped_up',
  'org.credits.adjusted',
] as const satisfies readonly AdminAuditAction[];

type IdLike = { toString(): string };

export type CreditEntryRow = {
  _id: Types.ObjectId;
  action: string;
  summary?: string;
  details?: Record<string, unknown>;
  changes?: AuditChange[];
  related?: { creditTransactionId?: string };
};

type LedgerRow = { _id: IdLike; credits?: number };

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// The writers' summary wording ("granted 500 credits" / "deducted 200 credits"); last-resort source.
const SUMMARY_PATTERN = /^(granted|deducted) (\d+) credits/;

const TOP_UP_SUMMARY_PATTERN = /^topped up (\d+) credits/;

const creditsFromBalanceChange = (row: CreditEntryRow): number | undefined => {
  const balance = row.changes?.find(change => change.field === 'currentCredits');
  const before = asNumber(balance?.before);
  const after = asNumber(balance?.after);
  return before !== undefined && after !== undefined ? after - before : undefined;
};

const creditsFromAdjustment = (row: CreditEntryRow, ledgerCredits: number | undefined): number | undefined => {
  if (ledgerCredits !== undefined) return ledgerCredits;
  const fromChange = creditsFromBalanceChange(row);
  if (fromChange !== undefined) return fromChange;
  const match = row.summary?.match(SUMMARY_PATTERN);
  if (!match) return undefined;
  return match[1] === 'deducted' ? -Number(match[2]) : Number(match[2]);
};

/**
 * The signed credit amount an existing entry moved, or undefined when nothing on the entry says.
 * Ledger rows store deductions as negative credits, so they are already signed.
 */
export const resolveSignedCredits = (row: CreditEntryRow, ledgerCredits?: number): number | undefined => {
  switch (row.action) {
    case 'user.credits.adjusted':
      return creditsFromAdjustment(row, ledgerCredits);
    case 'org.credits.granted':
      return asNumber(row.details?.initialCredits);
    case 'org.credits.topped_up': {
      const stamped = asNumber(row.details?.credits);
      if (stamped !== undefined) return stamped;
      const match = row.summary?.match(TOP_UP_SUMMARY_PATTERN);
      return creditsFromBalanceChange(row) ?? (match ? Number(match[1]) : undefined);
    }
    case 'org.credits.adjusted':
      return asNumber(row.details?.credits) ?? creditsFromAdjustment(row, ledgerCredits);
    default:
      // subscription.granted already stamps `credits`; older rows may lack an amount.
      return asNumber(row.details?.credits);
  }
};

const unstampedFilter = { $not: { $type: 'number' } };

const loadLedgerCredits = async (rows: CreditEntryRow[]): Promise<Map<string, number>> => {
  const ids = rows.map(row => row.related?.creditTransactionId).filter((id): id is string => !!id);
  if (ids.length === 0) return new Map();
  const ledgerRows = await CreditTransaction.find({ _id: { $in: ids } })
    .select('credits')
    .lean<LedgerRow[]>();
  return new Map(
    ledgerRows.flatMap(row => {
      const credits = asNumber(row.credits);
      return credits === undefined ? [] : [[row._id.toString(), credits] as const];
    })
  );
};

const migration: MigrationFile = {
  id: 20260921235943,
  name: 'backfill-admin-audit-credits',
  up: async () => {
    let lastId: Types.ObjectId | undefined;
    let stamped = 0;
    let unresolved = 0;

    for (;;) {
      const rows = await AdminAuditLogModel.find({
        action: { $in: CREDIT_MOVING_ACTIONS },
        'details.credits': unstampedFilter,
        ...(lastId ? { _id: { $gt: lastId } } : {}),
      })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .select('action summary details changes related')
        .lean<CreditEntryRow[]>();
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1]._id;

      const ledgerCredits = await loadLedgerCredits(rows);
      const updates = rows.flatMap(row => {
        const credits = resolveSignedCredits(
          row,
          row.related?.creditTransactionId ? ledgerCredits.get(row.related.creditTransactionId) : undefined
        );
        if (credits === undefined) {
          unresolved += 1;
          return [];
        }
        return [
          {
            updateOne: {
              // Re-asserts the unstamped guard so a re-run, or a concurrent writer, is never overwritten.
              filter: { _id: row._id, 'details.credits': unstampedFilter },
              update: { $set: { 'details.credits': credits } },
            },
          },
        ];
      });

      // The raw collection on purpose: the model's hooks refuse every update to keep entries
      // immutable, and this one-time stamp only adds a derived amount the entry already implied.
      if (updates.length > 0) {
        const result = await AdminAuditLogModel.collection.bulkWrite(updates, { ordered: false });
        stamped += result.modifiedCount;
      }
    }

    console.log(`${LOG} stamped ${stamped} entries; ${unresolved} had no recoverable amount`);
  },

  // One-way: removing the stamp would only lose information.
  down: async () => {},
};

export default migration;
