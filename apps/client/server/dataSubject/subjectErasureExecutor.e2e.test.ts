import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { softDeletePlugin } from '../../../../packages/database/src/utils/mongo';
import { DELETED_USER_EMAIL, DELETED_USER_ID, DELETED_USER_NAME, DELETED_USER_OBJECT_ID } from './placeholder';
import { SubjectErasureExecutor } from './subjectErasureExecutor';
import { SubjectErasurePlan, unerased } from './subjectErasurePlan';
import type { DataHolderRegistry } from './types';

const ObjectId = Schema.Types.ObjectId;

const Person = mongoose.model('DsxPerson', new Schema({ email: String, invitedBy: ObjectId }));
const Note = mongoose.model('DsxNote', new Schema({ ownerId: ObjectId }));
const Event = mongoose.model(
  'DsxEvent',
  new Schema({
    actorId: ObjectId,
    actorName: { type: String, required: true },
    actorIp: String,
    actorRef: String,
    actorEmail: String,
  })
);
const Team = mongoose.model(
  'DsxTeam',
  new Schema({
    users: [{ userId: ObjectId, role: String, _id: false }],
    memberIds: [ObjectId],
    invitedEmails: [String],
  })
);
const Page = mongoose.model(
  'DsxPage',
  new Schema({ versions: [{ createdBy: ObjectId, createdByName: String, text: String, _id: false }] })
);
const Ledger = mongoose.model('DsxLedger', new Schema({ ownerId: ObjectId, campaign: String, watcherIds: [ObjectId] }));
const Organization = mongoose.model('Organization');

const retention = { expiresBy: 'policy', years: 7, from: 'the transaction date' } as const;

const softNotebook = new Schema({ ownerId: ObjectId });
softNotebook.plugin(softDeletePlugin);
const Notebook = mongoose.model('DsxNotebook', softNotebook);
const softMessage = new Schema({ notebookId: ObjectId, authorId: ObjectId, text: String });
softMessage.plugin(softDeletePlugin);
const Message = mongoose.model('DsxMessage', softMessage);
const Access = mongoose.model('DsxAccess', new Schema({ viewerId: ObjectId }));
const AccessQuery = mongoose.model('DsxAccessQuery', new Schema({ accessId: ObjectId, text: String }));
const Invoice = mongoose.model('DsxInvoice', new Schema({ ownerId: ObjectId }));
const InvoiceLine = mongoose.model('DsxInvoiceLine', new Schema({ invoiceId: ObjectId }));

const childRegistry: DataHolderRegistry = {
  DsxNotebook: { kind: 'holder', references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }] },
  DsxMessage: {
    kind: 'viaParent',
    parent: 'DsxNotebook',
    foreignKey: 'notebookId',
    attribution: [{ path: 'authorId', matchBy: 'userId', action: 'anonymize' }],
  },
  DsxAccess: { kind: 'holder', references: [{ path: 'viewerId', matchBy: 'userId', action: 'anonymize' }] },
  DsxAccessQuery: { kind: 'viaParent', parent: 'DsxAccess', foreignKey: 'accessId', deleteWhenParentAnonymized: true },
  DsxInvoice: {
    kind: 'holder',
    references: [{ path: 'ownerId', matchBy: 'userId', action: 'retain', reason: 'Bookkeeping law', retention }],
  },
  DsxInvoiceLine: { kind: 'viaParent', parent: 'DsxInvoice', foreignKey: 'invoiceId' },
};

const registry: DataHolderRegistry = {
  DsxPerson: {
    kind: 'subject',
    secretPaths: [],
    references: [{ path: 'invitedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  DsxNote: { kind: 'holder', references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }] },
  DsxEvent: {
    kind: 'holder',
    references: [
      { path: 'actorId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorName', 'actorIp'] },
      { path: 'actorRef', matchBy: 'userId', action: 'anonymize' },
      { path: 'actorEmail', matchBy: 'email', action: 'anonymize' },
    ],
  },
  DsxTeam: {
    kind: 'holder',
    references: [
      { path: 'users.userId', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'memberIds', matchBy: 'userId', action: 'pullFromArray' },
      { path: 'invitedEmails', matchBy: 'email', action: 'pullFromArray' },
    ],
  },
  DsxPage: {
    kind: 'holder',
    references: [
      { path: 'versions.createdBy', matchBy: 'userId', action: 'anonymize', alsoRedact: ['versions.createdByName'] },
    ],
  },
  DsxLedger: {
    kind: 'holder',
    references: [
      {
        path: 'ownerId',
        matchBy: 'userId',
        action: 'retain',
        reason: 'Bookkeeping law',
        retention,
        alsoRedact: ['campaign'],
      },
      { path: 'watcherIds', matchBy: 'userId', action: 'pullFromArray' },
    ],
  },
  Organization: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['billingContact'] }],
  },
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

const noLease = async () => {};
const raw = (model: mongoose.Model<never>) => model.collection.find({}).sort({ _id: 1 }).toArray();

async function seedPerson() {
  const me = await Person.create({ email: 'Me@Example.com' });
  const other = await Person.create({ email: 'them@example.com', invitedBy: me._id });
  return { me, other, subject: { userId: me.id as string, email: 'me@example.com' } };
}

describe('SubjectErasureExecutor', () => {
  it('deletes, anonymizes, pulls and redacts what the plan decides', async () => {
    const { me, other, subject } = await seedPerson();
    await Note.create({ ownerId: me._id });
    const theirNote = await Note.create({ ownerId: other._id });
    const event = await Event.create({
      actorId: me._id,
      actorName: 'Me',
      actorIp: '203.0.113.9',
      actorRef: me.id,
      actorEmail: 'ME@example.com',
    });
    const team = await Team.create({
      users: [
        { userId: me._id, role: 'owner' },
        { userId: other._id, role: 'member' },
      ],
      memberIds: [me._id, other._id],
      invitedEmails: ['ME@EXAMPLE.COM', 'them@example.com'],
    });
    const page = await Page.create({
      versions: [
        { createdBy: me._id, createdByName: 'Me', text: 'a' },
        { createdBy: other._id, createdByName: 'Them', text: 'b' },
      ],
    });
    const ledger = await Ledger.create({ ownerId: me._id, campaign: 'spring', watcherIds: [me._id, other._id] });

    await new SubjectErasureExecutor(subject, noLease, registry).run();

    // Their own User row is left for hardDeleteUser; their reference on another's row is anonymized.
    expect(await Person.exists({ _id: me._id })).toBeTruthy();
    expect((await Person.findById(other._id).lean())?.invitedBy).toEqual(DELETED_USER_OBJECT_ID);
    expect((await Note.find().lean()).map(({ _id }) => String(_id))).toEqual([String(theirNote._id)]);

    const erasedEvent = await Event.collection.findOne({ _id: event._id });
    expect(erasedEvent).toMatchObject({
      actorId: DELETED_USER_OBJECT_ID,
      actorName: DELETED_USER_NAME,
      actorRef: DELETED_USER_ID,
      actorEmail: DELETED_USER_EMAIL,
    });
    expect(erasedEvent).not.toHaveProperty('actorIp');

    expect(await Team.collection.findOne({ _id: team._id })).toMatchObject({
      users: [{ userId: other._id, role: 'member' }],
      memberIds: [other._id],
      invitedEmails: ['them@example.com'],
    });
    expect((await Page.collection.findOne({ _id: page._id }))?.versions).toEqual([
      { createdBy: DELETED_USER_OBJECT_ID, text: 'a' },
      { createdBy: other._id, createdByName: 'Them', text: 'b' },
    ]);

    const kept = await Ledger.collection.findOne({ _id: ledger._id });
    expect(kept).toMatchObject({ ownerId: me._id, watcherIds: [other._id] });
    expect(kept).not.toHaveProperty('campaign');
  });

  it('anonymizes a shared organization but leaves personal workspaces to hardDeleteUser', async () => {
    const { me, subject } = await seedPerson();
    const shared = new mongoose.Types.ObjectId();
    const workspace = new mongoose.Types.ObjectId();
    await Organization.collection.insertMany([
      { _id: shared, name: 'Team', userId: me.id, billingContact: 'me@example.com' },
      { _id: workspace, name: 'Mine', userId: me.id, personal: true, billingContact: 'me@example.com' },
    ]);

    await new SubjectErasureExecutor(subject, noLease, registry).run();

    const sharedAfter = await Organization.collection.findOne({ _id: shared });
    // `userId` is a String path, so it takes the string placeholder.
    expect(sharedAfter?.userId).toBe(DELETED_USER_ID);
    expect(sharedAfter).not.toHaveProperty('billingContact');
    expect(await Organization.collection.findOne({ _id: workspace })).toMatchObject({
      userId: me.id,
      billingContact: 'me@example.com',
    });
    const remaining = unerased(await new SubjectErasurePlan(subject, registry).collections()).map(({ model }) => model);
    expect(remaining).toEqual(['DsxPerson', 'Organization']);
  });

  it('stops writing when the lease is lost, leaving later models untouched', async () => {
    const { me, subject } = await seedPerson();
    await Note.create({ ownerId: me._id });
    const team = await Team.create({ memberIds: [me._id] });
    const lease = async () => {
      if ((await Note.countDocuments()) === 0) throw new Error('lease lost');
    };

    await expect(new SubjectErasureExecutor(subject, lease, registry).run()).rejects.toThrow('lease lost');

    expect(await Note.countDocuments()).toBe(0);
    expect((await Team.collection.findOne({ _id: team._id }))?.memberIds).toEqual([me._id]);
  });

  it('changes nothing on a second run', async () => {
    const { me, other, subject } = await seedPerson();
    await Event.create({ actorId: me._id, actorName: 'Me', actorEmail: 'me@example.com' });
    await Team.create({ users: [{ userId: me._id }, { userId: other._id }], memberIds: [me._id] });
    await Ledger.create({ ownerId: me._id, campaign: 'spring' });
    await new SubjectErasureExecutor(subject, noLease, registry).run();
    const snapshot = async () => Promise.all([Person, Event, Team, Ledger].map(model => raw(model as never)));
    const before = await snapshot();

    await new SubjectErasureExecutor(subject, noLease, registry).run();

    expect(await snapshot()).toEqual(before);
  });
});

describe('SubjectErasureExecutor with viaParent children', () => {
  const me = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  const subject = { userId: me.toString(), email: null };

  it('deletes children with their parent, anonymizes attribution and keeps a retained parent whole', async () => {
    const mine = await Notebook.create({ ownerId: me });
    const theirs = await Notebook.create({ ownerId: other });
    await Message.create({ notebookId: mine._id, authorId: other, text: 'on my notebook' });
    const myReply = await Message.create({ notebookId: theirs._id, authorId: me, text: 'my reply' });
    const theirMessage = await Message.create({ notebookId: theirs._id, authorId: other, text: 'theirs' });
    const access = await Access.create({ viewerId: me });
    await AccessQuery.create({ accessId: access._id, text: 'my search' });
    const invoice = await Invoice.create({ ownerId: me });
    const line = await InvoiceLine.create({ invoiceId: invoice._id });

    await new SubjectErasureExecutor(subject, async () => {}, childRegistry).run();

    expect((await Notebook.collection.find().toArray()).map(({ _id }) => String(_id))).toEqual([String(theirs._id)]);
    expect(
      (await Message.collection.find().sort({ _id: 1 }).toArray()).map(({ _id, authorId }) => [String(_id), authorId])
    ).toEqual([
      [String(myReply._id), DELETED_USER_OBJECT_ID],
      [String(theirMessage._id), other],
    ]);
    expect((await Access.collection.findOne({ _id: access._id }))?.viewerId).toEqual(DELETED_USER_OBJECT_ID);
    expect(await AccessQuery.collection.countDocuments()).toBe(0);
    expect(await Invoice.collection.findOne({ _id: invoice._id })).toMatchObject({ ownerId: me });
    expect(await InvoiceLine.collection.countDocuments({ _id: line._id })).toBe(1);
  });

  it('removes a soft-deleted parent and its soft-deleted child', async () => {
    const notebook = await Notebook.create({ ownerId: me });
    const message = await Message.create({ notebookId: notebook._id, authorId: other });
    await message.softDelete();
    await notebook.softDelete();
    expect(await Notebook.collection.countDocuments()).toBe(1);

    await new SubjectErasureExecutor(subject, async () => {}, childRegistry).run();

    expect(await Notebook.collection.countDocuments()).toBe(0);
    expect(await Message.collection.countDocuments()).toBe(0);
  });

  it('leaves no orphaned child when the lease is lost between a parent and its children', async () => {
    const notebook = await Notebook.create({ ownerId: me });
    await Message.create({ notebookId: notebook._id, authorId: other });
    const access = await Access.create({ viewerId: me });
    await AccessQuery.create({ accessId: access._id, text: 'my search' });
    // Lost the first time a parent and its children are not both present or both gone.
    let lost = false;
    const lease = async () => {
      if (lost) return;
      const notebookGone = (await Notebook.collection.countDocuments()) === 0;
      const messagesGone = (await Message.collection.countDocuments({ notebookId: notebook._id })) === 0;
      const accessAnonymized = (await Access.collection.countDocuments({ viewerId: me })) === 0;
      const queriesGone = (await AccessQuery.collection.countDocuments()) === 0;
      if (notebookGone !== messagesGone || accessAnonymized !== queriesGone) {
        lost = true;
        throw new Error('lease lost');
      }
    };

    await expect(new SubjectErasureExecutor(subject, lease, childRegistry).run()).rejects.toThrow('lease lost');
    await new SubjectErasureExecutor(subject, lease, childRegistry).run();

    expect(await Notebook.collection.countDocuments()).toBe(0);
    expect(await Message.collection.countDocuments({ notebookId: notebook._id })).toBe(0);
    expect(await AccessQuery.collection.countDocuments({ accessId: access._id })).toBe(0);
    expect((await Access.collection.findOne({ _id: access._id }))?.viewerId).toEqual(DELETED_USER_OBJECT_ID);
  });
});
