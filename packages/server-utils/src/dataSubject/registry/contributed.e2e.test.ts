import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mongoose } from '@bike4mind/database';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  contributed: {
    FixtureOverlayNote: {
      kind: 'holder',
      references: [{ path: 'ownerId', matchBy: 'userId', action: 'deleteDocument' }],
    },
    FixtureOverlayLog: {
      kind: 'holder',
      references: [{ path: 'actorId', matchBy: 'userId', action: 'anonymize', alsoRedact: ['actorName'] }],
    },
  },
}));

// Registered before the registry module loads, so the first-use check finds them.
vi.mock('../../premium-generated/premiumDataSubjectRegistry.generated', async () => {
  const { mongoose: db } = await import('@bike4mind/database');
  const { Schema: S } = await import('mongoose');
  db.model('FixtureOverlayNote', new S({ ownerId: S.Types.ObjectId, text: String }));
  db.model('FixtureOverlayLog', new S({ actorId: S.Types.ObjectId, actorName: String, text: String }));
  return { premiumDataSubjectRegistries: [h.contributed] };
});
vi.mock('../../services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: vi.fn(async () => undefined),
}));
vi.mock('../../auth/signupNetworkLimits', () => ({
  retainDeletedSignupTraces: vi.fn(async () => undefined),
}));

import { erasureRegistry } from '../erasureRegistry';
import { DATA_HOLDER_REGISTRY } from './index';
import { SubjectRecordExport } from '../subjectRecordExport';
import { DELETED_USER_OBJECT_ID } from '../placeholder';

const Note = mongoose.model('FixtureOverlayNote');
const Log = mongoose.model('FixtureOverlayLog');

let mongoServer: MongoMemoryReplSet | undefined;

beforeAll(async () => {
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const assertLease = async () => {};
const collect = async (subject: { userId: string; email: string | null }, model: string) => {
  const rows: Record<string, unknown>[] = [];
  for await (const record of new SubjectRecordExport(subject).records(model)) rows.push(record);
  return rows;
};

describe('a contributed registry over a real database', () => {
  it('has the fixture entries beside the core ones', () => {
    expect(Object.keys(h.contributed).every(name => Object.hasOwn(DATA_HOLDER_REGISTRY, name))).toBe(true);
    expect(DATA_HOLDER_REGISTRY.User.kind).toBe('subject');
  });

  it('exports the person rows of a contributed model and nobody else', async () => {
    const userId = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await Note.create([
      { ownerId: userId, text: 'mine' },
      { ownerId: other, text: 'theirs' },
    ]);
    const subject = { userId: userId.toString(), email: null };
    expect(await new SubjectRecordExport(subject).walkOrder()).toContain('FixtureOverlayNote');
    const rows = await collect(subject, 'FixtureOverlayNote');
    expect(rows.map(row => row.text)).toEqual(['mine']);
  });

  it('scopes, then erases or pseudonymizes the contributed rows per kind of action', async () => {
    const userId = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await Note.create([
      { ownerId: userId, text: 'mine' },
      { ownerId: other, text: 'theirs' },
    ]);
    await Log.create([
      { actorId: userId, actorName: 'Person', text: 'did a thing' },
      { actorId: other, actorName: 'Other', text: 'did another' },
    ]);
    const subject = { userId: userId.toString(), email: null };

    const scoped = await erasureRegistry.scope(subject, assertLease);
    expect(scoped.map(collection => collection.model)).toEqual(
      expect.arrayContaining(['FixtureOverlayNote', 'FixtureOverlayLog'])
    );

    await erasureRegistry.erase(subject, assertLease);

    expect(await Note.find({ ownerId: userId })).toHaveLength(0);
    expect(await Note.find({ ownerId: other })).toHaveLength(1);
    const logs = await Log.find({ text: 'did a thing' }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId?.toString()).toBe(DELETED_USER_OBJECT_ID.toString());
    expect(logs[0].actorName).not.toBe('Person');
    expect((await Log.findOne({ text: 'did another' }).lean<{ actorName?: string }>())?.actorName).toBe('Other');
  });
});
