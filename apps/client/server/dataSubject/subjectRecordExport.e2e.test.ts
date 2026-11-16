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
  // `organizationId` is a String, as on every real personal-scoped model: the purge's personal
  // predicate (shared with the export) matches workspace ids as strings.
  new Schema({ ownerId: ObjectId, organizationId: String, body: String, shareToken: String })
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
const AuthAudit = mongoose.model(
  'DsTestAuthAudit',
  new Schema({ userId: ObjectId, actorUserId: ObjectId, actorIp: String, userAgent: String })
);
const Session = mongoose.model(
  'DsTestSession',
  new Schema({ userId: ObjectId, impersonatedBy: ObjectId, device: { ip: String } })
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
    references: [
      { path: 'ownerId', matchBy: 'userId', action: 'deleteDocument', scope: 'personal' },
      { path: 'ownerId', matchBy: 'userId', action: 'anonymize' },
    ],
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
  DsTestAuthAudit: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorIp', 'userAgent'] },
      { path: 'actorUserId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorIp', 'userAgent'] },
    ],
  },
  DsTestSession: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'impersonatedBy', matchBy: 'userId', action: 'anonymize', alsoRedact: ['device'] },
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

/** Makes `model.find` fail with `error` from the cursor whenever the filter names `path`. */
function failQueriesOn<T>(model: mongoose.Model<T>, path: string, error: Error) {
  const find = model.find.bind(model);
  return vi.spyOn(model, 'find').mockImplementation(((filter: Record<string, unknown>) => {
    if (!(path in filter)) return find(filter);
    return {
      setOptions: () => ({
        maxTimeMS: () => ({
          lean: () => ({
            cursor: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) }),
          }),
        }),
      }),
    };
  }) as unknown as typeof model.find);
}

const maxTimeExpired = () =>
  new mongoose.mongo.MongoServerError({ message: 'operation exceeded time limit', code: 50 });

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

  it('walks the own record first, then holders smallest collection first, and viaParent children last', async () => {
    await Team.insertMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    await Note.create({ body: 'one' });
    const exporter = new SubjectRecordExport(
      { userId: new mongoose.Types.ObjectId().toString(), email: null },
      registry
    );

    const order = await exporter.walkOrder();

    expect(order).toEqual([
      'DsTestPerson',
      'DsTestAccess',
      'DsTestAuthAudit',
      'DsTestLedger',
      'DsTestSession',
      'DsTestNote',
      'DsTestTeam',
      'DsTestAccessQuery',
      'DsTestNoteComment',
    ]);
  });

  it('exports the other references of a model when one reference query fails on the server', async () => {
    const subject = new mongoose.Types.ObjectId();
    const owned = await Ledger.create({ ownerId: subject, amount: 1 });
    const party = await Ledger.create({ partyIds: [subject], amount: 2 });
    const spy = failQueriesOn(Ledger, 'ownerId', maxTimeExpired());
    try {
      const exporter = new SubjectRecordExport({ userId: subject.toString(), email: null }, registry);

      const records = json(await collect(exporter, 'DsTestLedger'));

      expect(records.map((record: ExportedRecord) => record._id)).toEqual([party.id]);
      expect(records).not.toContainEqual(expect.objectContaining({ _id: owned.id }));
      expect(exporter.failedReferences('DsTestLedger').map(({ path }) => path)).toEqual(['ownerId']);
      expect(exporter.failedReferences('DsTestNote')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('flags the children of a parent whose reference timed out as incomplete too', async () => {
    const subject = new mongoose.Types.ObjectId();
    await Note.create({ ownerId: subject, body: 'mine' });
    const spy = failQueriesOn(Note, 'ownerId', maxTimeExpired());
    try {
      const exporter = new SubjectRecordExport({ userId: subject.toString(), email: null }, registry);

      expect(await collect(exporter, 'DsTestNote')).toEqual([]);
      expect(await collect(exporter, 'DsTestNoteComment')).toEqual([]);
      expect(exporter.failedReferences('DsTestNote').map(({ path }) => path)).toEqual(['ownerId']);
      expect(exporter.failedReferences('DsTestNoteComment').map(({ path }) => path)).toEqual(['noteId']);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails the whole model on a server error other than running out of time', async () => {
    const subject = new mongoose.Types.ObjectId();
    await Ledger.create({ partyIds: [subject] });
    const spy = failQueriesOn(
      Ledger,
      'ownerId',
      new mongoose.mongo.MongoServerError({ message: 'not primary', code: 10107 })
    );
    try {
      const exporter = new SubjectRecordExport({ userId: subject.toString(), email: null }, registry);

      await expect(collect(exporter, 'DsTestLedger')).rejects.toThrow('not primary');
    } finally {
      spy.mockRestore();
    }
  });

  it('still fails the whole model when a reference query fails off the server', async () => {
    const subject = new mongoose.Types.ObjectId();
    await Ledger.create({ partyIds: [subject] });
    const spy = vi.spyOn(Ledger, 'find').mockImplementation((() => {
      throw new Error('connection reset');
    }) as unknown as typeof Ledger.find);
    try {
      const exporter = new SubjectRecordExport({ userId: subject.toString(), email: null }, registry);

      await expect(collect(exporter, 'DsTestLedger')).rejects.toThrow('connection reset');
    } finally {
      spy.mockRestore();
    }
  });

  it('exports a document matched by several references once', async () => {
    const subject = new mongoose.Types.ObjectId();
    await Ledger.create({ ownerId: subject, partyIds: [subject], adminId: subject });
    const exporter = new SubjectRecordExport({ userId: subject.toString(), email: null }, registry);

    expect(await collect(exporter, 'DsTestLedger')).toHaveLength(1);
  });

  it('exports only what names the subject, minus secrets, following each action', async () => {
    const subject = await Person.create({
      email: 'me@example.com',
      password: 'hash',
      invitedBy: new mongoose.Types.ObjectId(),
      profile: { bio: 'hi' },
    });
    const other = await Person.create({ email: 'them@example.com', password: 'hash2', invitedBy: subject._id });
    const orgId = new mongoose.Types.ObjectId();

    const workspace = new mongoose.Types.ObjectId();
    await mongoose.model('Organization').collection.insertOne({ _id: workspace, userId: subject._id, personal: true });

    const myNote = await Note.create({ ownerId: subject._id, body: 'mine', shareToken: 'tok' });
    const orgNote = await Note.create({ ownerId: subject._id, organizationId: String(orgId), body: 'org-owned' });
    const workspaceNote = await Note.create({
      ownerId: subject._id,
      organizationId: String(workspace),
      body: 'workspace',
    });
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
    expect(records.DsTestNote).toEqual([
      { _id: myNote.id, ownerId: subject.id, body: 'mine', __v: 0 },
      { _id: orgNote.id, ownerId: subject.id },
      { _id: workspaceNote.id, ownerId: subject.id, organizationId: String(workspace), body: 'workspace', __v: 0 },
    ]);
    expect(records.DsTestTeam).toEqual([
      { _id: team.id, users: [{ userId: subject.id, role: 'member' }], inviteEmails: ['me@example.com'] },
    ]);
    expect(records.DsTestNoteComment).toHaveLength(2);
    expect(records.DsTestNoteComment).toContainEqual({ _id: onMyNote.id, noteId: myNote.id, text: 'on mine', __v: 0 });
    expect(records.DsTestNoteComment).toContainEqual({ _id: myCommentElsewhere.id, authorId: subject.id });
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
    expect(byId(shared._id)).toEqual({ _id: shared.id, partyIds: [me.toString()] });
    expect(byId(actedOn._id)).toEqual({
      _id: actedOn.id,
      adminId: me.toString(),
      adminName: 'Me',
      adminIp: '10.0.0.2',
    });
  });

  it('leaves out a matched path that describes another person the record names', async () => {
    const me = new mongoose.Types.ObjectId();
    const admin = new mongoose.Types.ObjectId();
    const byAdmin = await AuthAudit.create({ userId: me, actorUserId: admin, actorIp: '10.0.0.1', userAgent: 'admin' });
    const unattributed = await AuthAudit.create({ userId: me, actorIp: '10.0.0.2', userAgent: 'mine' });
    const byMe = await AuthAudit.create({ userId: me, actorUserId: me, actorIp: '10.0.0.3', userAgent: 'mine' });
    const asActor = await AuthAudit.create({ userId: admin, actorUserId: me, actorIp: '10.0.0.4', userAgent: 'mine' });

    const exporter = new SubjectRecordExport({ userId: me.toString(), email: null }, registry);
    const records = json(await collect(exporter, 'DsTestAuthAudit'));
    const byId = (id: unknown) => records.find((record: ExportedRecord) => record._id === String(id));

    expect(records).toHaveLength(4);
    expect(byId(byAdmin._id)).toEqual({ _id: byAdmin.id, userId: me.toString() });
    expect(byId(unattributed._id)).toEqual({
      _id: unattributed.id,
      userId: me.toString(),
      actorIp: '10.0.0.2',
      userAgent: 'mine',
    });
    expect(byId(byMe._id)).toEqual({
      _id: byMe.id,
      userId: me.toString(),
      actorUserId: me.toString(),
      actorIp: '10.0.0.3',
      userAgent: 'mine',
    });
    expect(byId(asActor._id)).toEqual({ _id: asActor.id, actorUserId: me.toString() });
  });

  it("withholds an impersonating admin's device from the person's own session, and keeps a normal session's", async () => {
    const me = new mongoose.Types.ObjectId();
    const admin = new mongoose.Types.ObjectId();
    const normal = await Session.create({ userId: me, device: { ip: '10.0.0.5' } });
    const impersonated = await Session.create({ userId: me, impersonatedBy: admin, device: { ip: '10.0.0.6' } });

    const exporter = new SubjectRecordExport({ userId: me.toString(), email: null }, registry);
    const records = json(await collect(exporter, 'DsTestSession'));
    const byId = (id: unknown) => records.find((record: ExportedRecord) => record._id === String(id));

    expect(byId(normal._id)).toMatchObject({ device: { ip: '10.0.0.5' } });
    expect(byId(impersonated._id)).not.toHaveProperty('device');
    expect(byId(impersonated._id)).not.toHaveProperty('impersonatedBy');
  });

  it('matches an email reference whatever the case of the subject email', async () => {
    const team = await Team.create({ name: 't', inviteEmails: ['ada@example.com', 'bob@example.com'] });

    const exporter = new SubjectRecordExport(
      { userId: new mongoose.Types.ObjectId().toString(), email: 'Ada@Example.com' },
      registry
    );
    expect(json(await collect(exporter, 'DsTestTeam'))).toEqual([{ _id: team.id, inviteEmails: ['ada@example.com'] }]);
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
