import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { SubjectErasurePlan, unerased } from './subjectErasurePlan';
import type { DataHolderRegistry } from './types';

const ObjectId = Schema.Types.ObjectId;

const Person = mongoose.model('DsErasePerson', new Schema({ email: String, invitedBy: ObjectId }));
const Note = mongoose.model('DsEraseNote', new Schema({ ownerId: ObjectId, organizationId: ObjectId, slug: String }));
const NoteComment = mongoose.model('DsEraseNoteComment', new Schema({ noteId: ObjectId, authorId: ObjectId }));
const NoteView = mongoose.model('DsEraseNoteView', new Schema({ noteSlug: String }));
const Team = mongoose.model('DsEraseTeam', new Schema({ users: [{ userId: ObjectId, _id: false }] }));
const Access = mongoose.model('DsEraseAccess', new Schema({ viewerId: ObjectId }));
const AccessQuery = mongoose.model('DsEraseAccessQuery', new Schema({ text: String }));
const Ledger = mongoose.model('DsEraseLedger', new Schema({ ownerId: ObjectId, amount: Number }));
const LedgerLine = mongoose.model('DsEraseLedgerLine', new Schema({ ledgerId: ObjectId }));

const registry: DataHolderRegistry = {
  DsErasePerson: {
    kind: 'subject',
    references: [{ path: 'invitedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  DsEraseNote: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', where: { organizationId: null } }],
  },
  DsEraseNoteComment: {
    kind: 'viaParent',
    parent: 'DsEraseNote',
    foreignKey: 'noteId',
    attribution: [{ path: 'authorId', matchBy: 'userId', action: 'anonymize' }],
  },
  DsEraseNoteView: { kind: 'viaParent', parent: 'DsEraseNote', foreignKey: 'noteSlug', parentKey: 'slug' },
  DsEraseTeam: { kind: 'holder', references: [{ path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' }] },
  DsEraseAccess: { kind: 'holder', references: [{ path: 'viewerId', matchBy: 'userId', action: 'anonymize' }] },
  DsEraseAccessQuery: {
    kind: 'viaParent',
    parent: 'DsEraseAccess',
    foreignKey: '_id',
    deleteWhenParentAnonymized: true,
  },
  DsEraseLedger: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'retain', reason: 'Bookkeeping law' }],
  },
  DsEraseLedgerLine: { kind: 'viaParent', parent: 'DsEraseLedger', foreignKey: 'ledgerId' },
  DsEraseRelease: { kind: 'noUserData', note: 'test' },
};

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const byModel = async (plan: SubjectErasurePlan) =>
  Object.fromEntries((await plan.collections()).map(({ model, ...counts }) => [model, counts]));

describe('SubjectErasurePlan', () => {
  it('counts what an erasure deletes, anonymizes and keeps, following parents to their children', async () => {
    const me = await Person.create({ email: 'me@example.com' });
    const other = await Person.create({ email: 'them@example.com', invitedBy: me._id });

    const mine = await Note.create({ ownerId: me._id, slug: 'mine' });
    await Note.create({ ownerId: me._id, organizationId: new mongoose.Types.ObjectId(), slug: 'org' });
    const theirs = await Note.create({ ownerId: other._id, slug: 'theirs' });
    await NoteComment.create({ noteId: mine._id, authorId: other._id });
    await NoteComment.create({ noteId: theirs._id, authorId: me._id });
    await NoteComment.create({ noteId: theirs._id, authorId: other._id });
    await NoteView.create({ noteSlug: 'mine' });
    await NoteView.create({ noteSlug: 'theirs' });
    await Team.create({ users: [{ userId: me._id }, { userId: other._id }] });
    const access = await Access.create({ viewerId: me._id });
    await AccessQuery.create({ _id: access._id, text: 'q' });
    await AccessQuery.create({ text: 'unrelated' });
    const ledger = await Ledger.create({ ownerId: me._id, amount: 5 });
    await LedgerLine.create({ ledgerId: ledger._id });

    const counts = await byModel(new SubjectErasurePlan({ userId: me.id, email: 'me@example.com' }, registry));

    const none = { deleted: 0, anonymized: 0, retained: 0, retainReasons: [] };
    expect(counts).toEqual({
      // Their own row is deleted; their reference on the other person's row is anonymized.
      DsErasePerson: { ...none, deleted: 1, anonymized: 1 },
      DsEraseNote: { ...none, deleted: 1 },
      // The comment on their deleted note goes with it; their comment on another's note is anonymized.
      DsEraseNoteComment: { ...none, deleted: 1, anonymized: 1 },
      DsEraseNoteView: { ...none, deleted: 1 },
      DsEraseTeam: { ...none, anonymized: 1 },
      DsEraseAccess: { ...none, anonymized: 1 },
      DsEraseAccessQuery: { ...none, deleted: 1 },
      DsEraseLedger: { ...none, retained: 1, retainReasons: ['Bookkeeping law'] },
      DsEraseLedgerLine: { ...none, retained: 1, retainReasons: ['Kept with its DsEraseLedger record'] },
    });
  });

  it('reports nothing for a person no record names', async () => {
    await Note.create({ ownerId: new mongoose.Types.ObjectId(), slug: 'x' });
    const plan = new SubjectErasurePlan({ userId: new mongoose.Types.ObjectId().toString(), email: null }, registry);
    expect(await plan.collections()).toEqual([]);
  });

  it('stops when the checkpoint throws', async () => {
    const plan = new SubjectErasurePlan({ userId: new mongoose.Types.ObjectId().toString(), email: null }, registry);
    await expect(
      plan.collections(async () => {
        throw new Error('lease lost');
      })
    ).rejects.toThrow('lease lost');
  });
});

describe('unerased', () => {
  it('keeps only collections with something still to delete or anonymize', () => {
    const base = { deleted: 0, anonymized: 0, retained: 0, retainReasons: [] };
    expect(
      unerased([
        { ...base, model: 'A', deleted: 1 },
        { ...base, model: 'B', anonymized: 2 },
        { ...base, model: 'C', retained: 3, retainReasons: ['law'] },
      ]).map(({ model }) => model)
    ).toEqual(['A', 'B']);
  });
});
