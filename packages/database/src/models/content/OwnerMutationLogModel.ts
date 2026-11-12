import { createHash } from 'node:crypto';
import mongoose, { Schema, type ClientSession } from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';

export const OWNER_MIRROR_COVERAGE_COMPLETE = false;

type MutationKind = 'upsert' | 'delete';
type OwnerMutation = {
  ownerId: string;
  recordType: string;
  recordId: string;
  kind: MutationKind;
  version: string | null;
  seq: number;
  prevHash: string | null;
  hash: string;
  committedAt: Date;
};

type OwnerHead = { _id: string; seq: number; hash: string | null; floorSeq: number; floorHash: string | null };

const mutationSchema = new Schema<OwnerMutation>({
  ownerId: { type: String, required: true },
  recordType: { type: String, required: true },
  recordId: { type: String, required: true },
  kind: { type: String, enum: ['upsert', 'delete'], required: true },
  version: { type: String, default: null },
  seq: { type: Number, required: true },
  prevHash: { type: String, default: null },
  hash: { type: String, required: true },
  committedAt: { type: Date, required: true },
});
mutationSchema.index({ ownerId: 1, seq: 1 }, { unique: true });

const headSchema = new Schema<OwnerHead>({
  _id: { type: String, required: true },
  seq: { type: Number, required: true },
  hash: { type: String, default: null },
  floorSeq: { type: Number, required: true },
  floorHash: { type: String, default: null },
});

export const OwnerMutationLog =
  (mongoose.models.OwnerMutationLog as mongoose.Model<OwnerMutation> | undefined) ??
  mongoose.model<OwnerMutation>('OwnerMutationLog', mutationSchema);
export const OwnerMutationHead =
  (mongoose.models.OwnerMutationHead as mongoose.Model<OwnerHead> | undefined) ??
  mongoose.model<OwnerHead>('OwnerMutationHead', headSchema);

export type OwnerMutationInput = {
  recordType: string;
  recordId: string;
  beforeOwners: readonly string[];
  afterOwners: readonly string[];
  version: string | null;
};

const digest = (event: Omit<OwnerMutation, 'hash' | 'committedAt'>): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        event.ownerId,
        event.seq,
        event.prevHash,
        event.recordType,
        event.recordId,
        event.kind,
        event.version,
      ])
    )
    .digest('hex');

async function append(ownerId: string, input: OwnerMutationInput, kind: MutationKind, session: ClientSession) {
  await OwnerMutationHead.updateOne(
    { _id: ownerId },
    { $setOnInsert: { seq: 0, hash: null, floorSeq: 0, floorHash: null } },
    { upsert: true, session }
  );
  const previous = await OwnerMutationHead.findOneAndUpdate(
    { _id: ownerId },
    { $inc: { seq: 1 } },
    { new: false, session }
  ).lean<OwnerHead>();
  if (!previous) throw new Error('Owner mutation head is missing');
  const event = {
    ownerId,
    recordType: input.recordType,
    recordId: input.recordId,
    kind,
    version: kind === 'delete' ? null : input.version,
    seq: previous.seq + 1,
    prevHash: previous.hash,
  };
  const hash = digest(event);
  await OwnerMutationLog.create([{ ...event, hash, committedAt: new Date() }], { session });
  const updated = await OwnerMutationHead.updateOne({ _id: ownerId, seq: event.seq }, { $set: { hash } }, { session });
  if (updated.matchedCount !== 1) throw new Error('Owner mutation head advanced unexpectedly');
}

/** The source mutation must use this session, including any raw-driver operations. */
export async function writeOwnerMutation<T>(
  input: OwnerMutationInput,
  mutate: (session: ClientSession) => Promise<T>
): Promise<T> {
  if (!input.recordType || !input.recordId || !input.version)
    throw new Error('Owner mutation requires a version locator');
  const before = new Set(input.beforeOwners);
  const after = new Set(input.afterOwners);
  if (before.size + after.size === 0 || [...before, ...after].some(owner => !owner)) {
    throw new Error('Owner mutation requires valid owners');
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(async session => {
        const result = await mutate(session);
        for (const ownerId of new Set([...before, ...after].sort())) {
          await append(ownerId, input, after.has(ownerId) ? 'upsert' : 'delete', session);
        }
        return result;
      });
    } catch (error) {
      // A concurrent first append can race the unique owner-head upsert.
      if ((error as { code?: number }).code !== 11000 || attempt >= 3) throw error;
    }
  }
}

type Cursor = { ownerId: string; seq: number; hash: string | null };
export class OwnerMutationCursorError extends Error {}
export class OwnerMutationCoverageError extends Error {}

const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
const decode = (cursor: string, ownerId: string): Cursor => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('ownerId' in parsed) ||
      parsed.ownerId !== ownerId ||
      !('seq' in parsed) ||
      !Number.isSafeInteger(parsed.seq) ||
      (parsed.seq as number) < 0 ||
      !('hash' in parsed) ||
      (parsed.hash !== null && (typeof parsed.hash !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.hash)))
    )
      throw new Error('Invalid cursor');
    return parsed as Cursor;
  } catch {
    throw new OwnerMutationCursorError('Invalid owner mutation cursor');
  }
};

/** Internal read only: not safe to expose before every writer is fenced. */
export async function readOwnerMutationsInternal(ownerId: string, limit: number, cursor?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OwnerMutationCursorError('Invalid page size');
  const head = await OwnerMutationHead.findById(ownerId).lean<OwnerHead>();
  const position = cursor ? decode(cursor, ownerId) : { ownerId, seq: 0, hash: null };
  const floorSeq = head?.floorSeq ?? 0;
  if (position.seq < floorSeq) throw new OwnerMutationCursorError('Owner mutation cursor expired');
  if (position.seq > (head?.seq ?? 0)) throw new OwnerMutationCursorError('Owner mutation cursor is ahead of head');
  const anchor =
    position.seq === floorSeq
      ? (head?.floorHash ?? null)
      : (await OwnerMutationLog.findOne({ ownerId, seq: position.seq }).lean<OwnerMutation>())?.hash;
  if (anchor === undefined || anchor !== position.hash)
    throw new OwnerMutationCursorError('Owner mutation cursor has changed');

  const rows = await OwnerMutationLog.find({ ownerId, seq: { $gt: position.seq, $lte: head?.seq ?? 0 } })
    .sort({ seq: 1 })
    .limit(limit + 1)
    .lean<OwnerMutation[]>();
  const events = rows.slice(0, limit);
  let expectedSeq = position.seq;
  let expectedHash = position.hash;
  for (const row of events) {
    if (row.seq !== ++expectedSeq || row.prevHash !== expectedHash || row.hash !== digest(row))
      throw new OwnerMutationCursorError('Owner mutation chain has a gap');
    expectedHash = row.hash;
  }
  if (events.length === 0 && position.seq < (head?.seq ?? 0)) {
    throw new OwnerMutationCursorError('Owner mutation chain has a gap');
  }
  const last = events.at(-1);
  return {
    events,
    nextCursor: encode(last ? { ownerId, seq: last.seq, hash: last.hash } : position),
    hasMore: rows.length > limit,
    lagMs: null,
  };
}

export async function readOwnerMutations(ownerId: string, limit: number, cursor?: string) {
  if (!OWNER_MIRROR_COVERAGE_COMPLETE) throw new OwnerMutationCoverageError('Account mirror feed is not available');
  return readOwnerMutationsInternal(ownerId, limit, cursor);
}

/** Retention moves an owner-specific floor atomically with removal, so old cursors fail explicitly. */
export async function pruneOwnerMutations(ownerId: string, throughSeq: number): Promise<void> {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 1)
    throw new OwnerMutationCursorError('Invalid retention floor');
  await withTransaction(async session => {
    const head = await OwnerMutationHead.findById(ownerId).session(session).lean<OwnerHead>();
    if (!head || throughSeq <= head.floorSeq || throughSeq > head.seq)
      throw new OwnerMutationCursorError('Invalid retention floor');
    const event = await OwnerMutationLog.findOne({ ownerId, seq: throughSeq }).session(session).lean<OwnerMutation>();
    if (!event) throw new OwnerMutationCursorError('Retention anchor is missing');
    await OwnerMutationHead.updateOne(
      { _id: ownerId, floorSeq: head.floorSeq },
      { $set: { floorSeq: throughSeq, floorHash: event.hash } },
      { session }
    );
    await OwnerMutationLog.deleteMany({ ownerId, seq: { $lte: throughSeq } }).session(session);
  });
}
