import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { SubjectRecordExport, assertEveryModelClassified, type ExportedRecord } from './subjectRecordExport';
import type { DataHolderRegistry } from './types';

const ObjectId = Schema.Types.ObjectId;

const Person = mongoose.model(
  'DsTestPerson',
  new Schema({ email: String, password: String, invitedBy: ObjectId, profile: { bio: String } })
);
const Note = mongoose.model(
  'DsTestNote',
  new Schema({ ownerId: ObjectId, organizationId: ObjectId, body: String, shareToken: String })
);
const Team = mongoose.model(
  'DsTestTeam',
  new Schema({
    name: String,
    users: [{ userId: ObjectId, role: String, _id: false }],
    inviteEmails: [String],
  })
);
const NoteComment = mongoose.model(
  'DsTestNoteComment',
  new Schema({ noteId: ObjectId, authorId: ObjectId, text: String })
);
const Access = mongoose.model('DsTestAccess', new Schema({ viewerId: ObjectId, at: Date }));
const AccessQuery = mongoose.model('DsTestAccessQuery', new Schema({ text: String }));
const Ledger = mongoose.model(
  'DsTestLedger',
  new Schema({
    ownerId: ObjectId,
    partyIds: [ObjectId],
    adminId: ObjectId,
    adminName: String,
    adminIp: String,
    amount: Number,
  })
);
const Undeclared = mongoose.model('DsTestUndeclared', new Schema({ ownerId: ObjectId }));

const registry: DataHolderRegistry = {
  DsTestPerson: {
    kind: 'subject',
    secretPaths: ['password'],
    references: [{ path: 'invitedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  DsTestNote: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', where: { organizationId: null } }],
    secretPaths: ['shareToken'],
  },
  DsTestTeam: {
    kind: 'holder',
    references: [
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'inviteEmails', matchBy: 'email', action: 'pullFromArray' },
    ],
  },
  DsTestNoteComment: {
    kind: 'viaParent',
    parent: 'DsTestNote',
    foreignKey: 'noteId',
    attribution: [{ path: 'authorId', matchBy: 'userId', action: 'anonymize' }],
  },
  DsTestAccess: {
    kind: 'holder',
    references: [{ path: 'viewerId', matchBy: 'userId', action: 'anonymize' }],
  },
  DsTestAccessQuery: {
    kind: 'viaParent',
    parent: 'DsTestAccess',
    foreignKey: '_id',
    deleteWhenParentAnonymized: true,
  },
  DsTestLedger: {
    kind: 'holder',
    references: [
      { path: 'ownerId', matchBy: 'userId', action: 'retain', reason: 'test' },
      { path: 'partyIds', matchBy: 'userId', action: 'retain', reason: 'test' },
      {
        path: 'adminId',
        matchBy: 'userId',
        action: 'retain',
        reason: 'test',
        identifies: ['adminName', 'adminIp'],
        exportScope: 'reference',
      },
    ],
  },
  DsTestRelease: { kind: 'noUserData', note: 'test' },
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

async function collect(exporter: SubjectRecordExport, model: string): Promise<ExportedRecord[]> {
  const records: ExportedRecord[] = [];
  for await (const record of exporter.records(model)) records.push(record);
  return records;
}

async function exportAll(exporter: SubjectRecordExport) {
  const byModel: Record<string, ExportedRecord[]> = {};
  for (const model of exporter.models) byModel[model] = await collect(exporter, model);
  return byModel;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('SubjectRecordExport', () => {
  it('orders every child after its parent and skips models with no user data', () => {
    const { models } = new SubjectRecordExport(
      { userId: new mongoose.Types.ObjectId().toString(), email: null },
      registry
    );
    expect(models).not.toContain('DsTestRelease');
    expect(models.indexOf('DsTestNote')).toBeLessThan(models.indexOf('DsTestNoteComment'));
    expect(models.indexOf('DsTestAccess')).toBeLessThan(models.indexOf('DsTestAccessQuery'));
  });

  it('exports only what names the subject, minus secrets, following each action', async () => {
    const subject = await Person.create({ email: 'me@example.com', password: 'hash', profile: { bio: 'hi' } });
    const other = await Person.create({ email: 'them@example.com', password: 'hash2', invitedBy: subject._id });
    const orgId = new mongoose.Types.ObjectId();

    const myNote = await Note.create({ ownerId: subject._id, body: 'mine', shareToken: 'tok' });
    await Note.create({ ownerId: subject._id, organizationId: orgId, body: 'org-owned' });
    const theirNote = await Note.create({ ownerId: other._id, body: 'theirs' });
    const team = await Team.create({
      name: 'secret team name',
      users: [
        { userId: subject._id, role: 'member' },
        { userId: other._id, role: 'owner' },
      ],
      inviteEmails: ['me@example.com', 'them@example.com'],
    });
    await Team.create({ name: 'unrelated', users: [{ userId: other._id, role: 'owner' }] });
    const onMyNote = await NoteComment.create({ noteId: myNote._id, authorId: other._id, text: 'on mine' });
    const myCommentElsewhere = await NoteComment.create({
      noteId: theirNote._id,
      authorId: subject._id,
      text: 'by me',
    });
    await NoteComment.create({ noteId: theirNote._id, authorId: other._id, text: 'not mine' });
    const access = await Access.create({ viewerId: subject._id, at: new Date() });
    const query = await AccessQuery.create({ _id: access._id, text: 'what I searched' });
    await Access.create({ _id: new mongoose.Types.ObjectId(), viewerId: other._id });

    const exporter = new SubjectRecordExport({ userId: subject.id, email: 'me@example.com' }, registry);
    const records = json(await exportAll(exporter));

    expect(records.DsTestPerson).toEqual([
      { _id: subject.id, email: 'me@example.com', profile: { bio: 'hi' }, __v: 0 },
    ]);
    expect(records.DsTestNote).toEqual([{ _id: myNote.id, ownerId: subject.id, body: 'mine', __v: 0 }]);
    expect(records.DsTestTeam).toEqual([
      { _id: team.id, users: [{ userId: subject.id, role: 'member' }], inviteEmails: ['me@example.com'] },
    ]);
    expect(records.DsTestNoteComment.map((record: ExportedRecord) => record._id).sort()).toEqual(
      [onMyNote.id, myCommentElsewhere.id].sort()
    );
    expect(records.DsTestAccess).toEqual([{ _id: access.id, viewerId: subject.id }]);
    expect(records.DsTestAccessQuery).toEqual([{ _id: query.id, text: 'what I searched', __v: 0 }]);
  });

  it('withholds every other person from a record about this person, and exports only the reference of an actor', async () => {
    const me = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const third = new mongoose.Types.ObjectId();
    const mine = await Ledger.create({
      ownerId: me,
      partyIds: [me, other],
      adminId: other,
      adminName: 'Admin',
      adminIp: '10.0.0.1',
      amount: 5,
    });
    const shared = await Ledger.create({ ownerId: other, partyIds: [third, me], amount: 7 });
    const actedOn = await Ledger.create({
      ownerId: other,
      partyIds: [other],
      adminId: me,
      adminName: 'Me',
      adminIp: '10.0.0.2',
      amount: 9,
    });
    await Ledger.create({ ownerId: other, adminId: third, adminName: 'Them', amount: 11 });

    const exporter = new SubjectRecordExport({ userId: me.toString(), email: null }, registry);
    const records = json(await collect(exporter, 'DsTestLedger'));
    const byId = (id: unknown) => records.find((record: ExportedRecord) => record._id === String(id));

    expect(records).toHaveLength(3);
    expect(byId(mine._id)).toEqual({
      _id: mine.id,
      ownerId: me.toString(),
      partyIds: [me.toString()],
      amount: 5,
      __v: 0,
    });
    expect(byId(shared._id)).toEqual({ _id: shared.id, partyIds: [me.toString()], amount: 7, __v: 0 });
    expect(byId(actedOn._id)).toEqual({
      _id: actedOn.id,
      adminId: me.toString(),
      adminName: 'Me',
      adminIp: '10.0.0.2',
    });
  });

  it('skips email references when the subject has no email', async () => {
    const subject = await Person.create({});
    await Team.create({ name: 't', inviteEmails: [''] });

    const exporter = new SubjectRecordExport({ userId: subject.id, email: null }, registry);
    expect(await collect(exporter, 'DsTestTeam')).toEqual([]);
  });

  it('refuses a child before its parent has been read in full', async () => {
    const exporter = new SubjectRecordExport(
      { userId: new mongoose.Types.ObjectId().toString(), email: null },
      registry
    );
    await expect(collect(exporter, 'DsTestNoteComment')).rejects.toThrow(/parent "DsTestNote" exported first/);
  });

  it('fails a reference to a path the schema does not declare instead of matching every document', async () => {
    await Undeclared.create({ ownerId: new mongoose.Types.ObjectId() });
    const exporter = new SubjectRecordExport(
      { userId: new mongoose.Types.ObjectId().toString(), email: null },
      {
        DsTestUndeclared: {
          kind: 'holder',
          references: [{ path: 'ownrId', matchBy: 'userId', action: 'deleteDocument' }],
        },
      }
    );
    await expect(collect(exporter, 'DsTestUndeclared')).rejects.toThrow(/not in schema|strictQuery/i);
  });
});

describe('assertEveryModelClassified', () => {
  it('refuses an unclassified model and accepts classified ones', () => {
    expect(() => assertEveryModelClassified(['User'])).not.toThrow();
    expect(() => assertEveryModelClassified(['User', 'NotARealModel'])).toThrow(/NotARealModel/);
  });
});
