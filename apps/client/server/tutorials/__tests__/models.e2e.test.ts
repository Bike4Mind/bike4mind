import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mongoose } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { tutorialModels } from '../models';
import { progressStoreFor } from '../progressStore';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
const owner = tutorialModels({ prefix: 'acme', modelPrefix: 'Acme' });
const core = tutorialModels({ prefix: '', modelPrefix: 'Core' });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, MONGO_TEST_TIMEOUT_MS);

describe('tutorial models against a real database', () => {
  it('round-trips an owner-shaped progress document and reads it back from the raw collection', async () => {
    const at = new Date('2026-10-28T12:00:00Z');
    await owner.Progress.create({
      userId: 'u1',
      modules: {
        demo: { status: 'in_progress', sessionId: 's1', turn: -1, moduleVersion: 1, turnClaimedAt: at, updatedAt: at },
      },
      journeys: { tour: { dismissedAt: at } },
    });
    const raw = await mongoose.connection.collection('acmetutorialprogress').findOne({ userId: 'u1' });
    expect(raw?.modules.demo).toMatchObject({ status: 'in_progress', sessionId: 's1', turn: -1 });
    const doc = await owner.Progress.findOne({ userId: 'u1' }).lean();
    expect(doc?.modules.get ? doc.modules.get('demo') : (doc?.modules as Record<string, unknown>).demo).toMatchObject({
      sessionId: 's1',
    });
  });

  it('round-trips override, change and draft documents', async () => {
    await owner.Override.create({
      moduleId: 'demo',
      revision: 1,
      contentSeq: 1,
      fields: [{ kind: 'reply' }],
      updatedBy: 'a',
      reason: 'r',
    });
    await owner.OverrideChange.create({
      moduleId: 'demo',
      field: 'body',
      before: 'a',
      after: 'b',
      actorId: 'a',
      reason: 'r',
    });
    await owner.Draft.create({
      moduleId: 'demo',
      title: 'T',
      sourceSessionId: 's',
      finale: { title: 'f', body: 'b' },
      steps: [],
      capturedBy: 'a',
      updatedBy: 'a',
    });
    expect(await owner.Override.findOne({ moduleId: 'demo' }).lean()).toMatchObject({
      revision: 1,
      fields: [{ kind: 'reply' }],
    });
    expect(await owner.OverrideChange.findOne({ moduleId: 'demo' }).lean()).toMatchObject({ after: 'b' });
    expect(await owner.Draft.findOne({ moduleId: 'demo' }).lean()).toMatchObject({ steps: [], enabled: false });
  });

  it('keeps core and owner rows in separate collections', async () => {
    await core.Override.create({ moduleId: 'demo', revision: 5, contentSeq: 1, updatedBy: 'c', reason: 'r' });
    expect(await owner.Override.findOne({ moduleId: 'demo' }).lean()).toMatchObject({ revision: 1 });
    expect(await core.Override.findOne({ moduleId: 'demo' }).lean()).toMatchObject({ revision: 5 });
    expect(await mongoose.connection.collection('tutorialoverrides').countDocuments()).toBe(1);
  });

  it('rejects a module id outside the allowed shape', async () => {
    await expect(
      core.Override.create({ moduleId: 'Bad Id', revision: 0, contentSeq: 0, updatedBy: 'c', reason: 'r' })
    ).rejects.toThrow();
  });

  it('does not move a finished walk back to in_progress, but still records a left one', async () => {
    const store = progressStoreFor(owner.Progress);
    const at = new Date('2026-10-28T12:00:00Z');
    await store.begin('u2', 'demo', {
      status: 'finished',
      sessionId: 's1',
      turn: 0,
      moduleVersion: 1,
      turnClaimedAt: at,
      updatedAt: at,
    });
    expect(await store.setPosition('u2', 'demo', 'a', 'in_progress', at)).toBe(false);
    expect((await store.read('u2', 'demo'))?.status).toBe('finished');
    expect(await store.setPosition('u2', 'demo', 'a', 'left', at)).toBe(true);
    expect((await store.read('u2', 'demo'))?.status).toBe('left');
  });
});
