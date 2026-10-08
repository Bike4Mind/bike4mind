import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, Quest, Session, User, defineAbilitiesFor as dbDefineAbilitiesFor } from '@bike4mind/database';
import { KnowledgeType, Permission, type IUserDocument } from '@bike4mind/common';
import { configureSlackPackage, sendMessageToNotebookAndGetResponse } from '@bike4mind/slack';
import defineAbilitiesFor from '@server/auth/ability';
import { getOrCreateSession, addMessageToSession } from '@server/managers/sessionManager';

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Drives the real getOrCreateSession -> sessionService.updateSession path, and the Slack handler
 * wired to it, against a real database: a file attached by id must stay in session.knowledgeIds.
 */

let mongoServer: MongoMemoryServer;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  configureSlackPackage(
    { sessionManager: { getOrCreateSession, addMessageToSession } } as never,
    {
      User,
      Quest,
      defineAbilitiesFor: dbDefineAbilitiesFor,
    } as never
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const createUser = async (name: string) => {
  const s = suffix();
  return (await User.create({
    name,
    username: `${name}-${s}`,
    email: `${name}-${s}@example.com`,
  })) as unknown as IUserDocument;
};
const createFile = async (userId: string, mimeType: string) =>
  String(
    (
      await FabFile.create({
        userId,
        fileName: `f-${suffix()}`,
        type: KnowledgeType.FILE,
        filePath: `knowledge/${suffix()}`,
        mimeType,
      })
    )._id
  );
const createSession = (fields: Record<string, unknown>) =>
  Session.create({ firstCreated: new Date(), lastUpdated: new Date(), ...fields });
const knowledgeIds = async (sessionId: string) =>
  ((await Session.findById(sessionId).lean()) as { knowledgeIds?: string[] }).knowledgeIds ?? [];

describe('file ids attached to an existing session persist across turns', () => {
  it('getOrCreateSession writes the new ids once, and a repeat is a no-op', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const pdf = await createFile(owner.id, 'application/pdf');
    const ability = defineAbilitiesFor(owner);

    const first = await getOrCreateSession({ sessionId: session.id, fabFileIds: [pdf], user: owner, ability, logger });
    expect(first.session.knowledgeIds).toEqual([pdf]);
    expect(await knowledgeIds(session.id)).toEqual([pdf]);

    const before = await Session.findById(session.id).lean();
    await getOrCreateSession({ sessionId: session.id, fabFileIds: [pdf], user: owner, ability, logger });
    expect(await Session.findById(session.id).lean()).toEqual(before);
  });

  it('Slack: a document persists to a shared notebook, an image does not, and both ride the turn', async () => {
    const owner = await createUser('owner');
    const sharee = await createUser('sharee');
    const session = await createSession({
      userId: owner.id,
      name: 'shared',
      users: [{ userId: sharee.id, permissions: [Permission.read, Permission.update] }],
    });
    const pdf = await createFile(sharee.id, 'application/pdf');
    const png = await createFile(sharee.id, 'image/png');
    const trigger = vi.fn().mockResolvedValue('ok');

    const result = await sendMessageToNotebookAndGetResponse(
      session.id,
      sharee.id,
      'summarize',
      '',
      logger,
      { triggerAIResponseWithContext: trigger } as never,
      undefined,
      [pdf, png],
      undefined,
      false,
      [],
      [
        { fabFileId: pdf, mimeType: 'application/pdf' },
        { fabFileId: png, mimeType: 'image/png' },
      ]
    );

    expect(result.text).toBe('ok');
    expect(trigger.mock.calls[0][4]).toEqual([pdf, png]);
    expect(await knowledgeIds(session.id)).toEqual([pdf]);
  });

  it('Slack: a file the sender cannot access is not persisted, and the reply still goes out', async () => {
    const owner = await createUser('owner');
    const sharee = await createUser('sharee');
    const session = await createSession({
      userId: owner.id,
      name: 'shared',
      users: [{ userId: sharee.id, permissions: [Permission.read, Permission.update] }],
    });
    const stranger = await createUser('stranger');
    const foreignPdf = await createFile(stranger.id, 'application/pdf');
    const trigger = vi.fn().mockResolvedValue('ok');

    const result = await sendMessageToNotebookAndGetResponse(
      session.id,
      sharee.id,
      'summarize',
      '',
      logger,
      { triggerAIResponseWithContext: trigger } as never,
      undefined,
      [foreignPdf],
      undefined,
      false,
      [],
      [{ fabFileId: foreignPdf, mimeType: 'application/pdf' }]
    );

    expect(result.text).toBe('ok');
    expect(await knowledgeIds(session.id)).toEqual([]);
  });
});
