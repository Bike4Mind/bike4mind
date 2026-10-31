import { Subscriber } from '@bike4mind/database';
import type { mongo, Types } from 'mongoose';
import { type MigrationFile } from './index';

const LOG = '[normalize-subscriber-emails]';

type Row = {
  _id: Types.ObjectId;
  email: string;
  deletedAt?: Date | null;
  createdAt?: Date;
  inviteGenerated?: boolean;
  inviteCode?: string | null;
  inviteGeneratedAt?: Date | null;
  inviteGeneratedBy?: string | null;
  startingCredits?: number | null;
  startingStorage?: number | null;
};

const ROW_FIELDS = [
  'email',
  'deletedAt',
  'createdAt',
  'inviteGenerated',
  'inviteCode',
  'inviteGeneratedAt',
  'inviteGeneratedBy',
  'startingCredits',
  'startingStorage',
] as const;

// Must match the trim + lowercase setters on SubscriberSchema.email.
const normalize = (email: string) => email.trim().toLowerCase();

const isLive = (row: Row) => row.deletedAt == null;

const byPreference = (a: Row, b: Row) =>
  Number(isLive(b)) - Number(isLive(a)) ||
  Number(!!b.inviteGenerated) - Number(!!a.inviteGenerated) ||
  (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) ||
  a._id.toHexString().localeCompare(b._id.toHexString());

/**
 * Plan the writes for one group of rows that share a normalized email. The row already holding the
 * normalized value is kept (the unique index means no other row can take it); otherwise the
 * preferred row is. The keeper inherits liveness and invite state from the group, and every other
 * row is soft-deleted with its original email left in place so the unique index still holds.
 */
function planGroup(key: string, rows: Row[], now: Date): mongo.AnyBulkWriteOperation[] {
  const sorted = [...rows].sort(byPreference);
  const keeper = sorted.find(row => row.email === key) ?? sorted[0];
  const others = sorted.filter(row => row !== keeper);
  const ops: mongo.AnyBulkWriteOperation[] = [];

  for (const row of others) {
    if (isLive(row)) {
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: { deletedAt: now } } } });
    }
  }

  const set: Record<string, unknown> = {};
  if (keeper.email !== key) set.email = key;
  if (!isLive(keeper) && others.some(isLive)) set.deletedAt = null;
  const invited = others.filter(row => row.inviteGenerated).sort(byPreference)[0];
  if (!keeper.inviteGenerated && invited) {
    Object.assign(set, {
      inviteGenerated: true,
      inviteCode: invited.inviteCode ?? null,
      inviteGeneratedAt: invited.inviteGeneratedAt ?? null,
      inviteGeneratedBy: invited.inviteGeneratedBy ?? null,
      startingCredits: invited.startingCredits ?? null,
      startingStorage: invited.startingStorage ?? null,
    });
  }
  if (Object.keys(set).length > 0) {
    ops.push({ updateOne: { filter: { _id: keeper._id }, update: { $set: set } } });
  }
  return ops;
}

/**
 * Trim and lowercase every stored subscriber email, folding rows that collide once normalized into
 * one live row. Idempotent: a re-run finds every keeper already normalized and every other group
 * member already soft-deleted, so it plans no writes.
 */
const migration: MigrationFile = {
  id: 20260921236500,
  name: 'normalize subscriber emails',

  up: async () => {
    const groups = new Map<string, Row[]>();
    const cursor = Subscriber.collection.find<Row>(
      { email: { $type: 'string' } },
      { projection: Object.fromEntries(ROW_FIELDS.map(field => [field, 1])) }
    );
    for await (const row of cursor) {
      const key = normalize(row.email);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    const now = new Date();
    const ops: mongo.AnyBulkWriteOperation[] = [];
    let merged = 0;
    for (const [key, rows] of groups) {
      if (rows.every(row => row.email === key)) continue;
      if (rows.length > 1) merged++;
      ops.push(...planGroup(key, rows, now));
    }

    if (ops.length === 0) {
      console.log(`${LOG} all subscriber emails already normalized`);
      return;
    }

    const result = await Subscriber.collection.bulkWrite(ops);
    console.log(`${LOG} updated ${result.modifiedCount} row(s); merged ${merged} case-variant group(s)`);
  },

  // Not reversible: the original casing of a normalized keeper is not kept.
  down: async () => {},
};

export default migration;
