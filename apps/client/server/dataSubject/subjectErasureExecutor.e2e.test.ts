import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
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
