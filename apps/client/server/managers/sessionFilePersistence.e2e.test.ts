import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  FabFile,
  Quest,
  Session,
  User,
  fabFileRepository,
  projectRepository,
  cacheRepository,
  defineAbilitiesFor as dbDefineAbilitiesFor,
} from '@bike4mind/database';
import { sessionRepository } from '@bike4mind/database/auth';
import { sessionService } from '@bike4mind/services';
import { KnowledgeType, Permission, type IUserDocument } from '@bike4mind/common';
import { configureSlackPackage, sendMessageToNotebookAndGetResponse } from '@bike4mind/slack';
import defineAbilitiesFor from '@server/auth/ability';
import { getOrCreateSession, addMessageToSession } from '@server/managers/sessionManager';
import { startAgentExecution } from '@server/utils/startAgentExecution';
import { HEADLESS_CONNECTION_ID } from '@server/utils/headlessConnection';

vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));
// The session.created push needs a socket endpoint; nothing here listens.
vi.mock('@server/managers/sessionSideEffects', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/managers/sessionSideEffects')>()),
  notifySessionCreated: vi.fn().mockResolvedValue(undefined),
}));
// The agent path runs for real up to the executor hand-off, which has no deployment here.
vi.mock('@server/utils/dispatchAgentExecution', () => ({
  resolveAgentExecutorTarget: () => ({ kind: 'lambda', functionName: 'agent-executor' }),
  dispatchAgentExecution: vi.fn().mockResolvedValue(undefined),
  AgentExecutorRejectedError: class extends Error {},
}));

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
const createFile = async (userId: string, mimeType: string, extra: Record<string, unknown> = {}) =>
  String(
    (
      await FabFile.create({
        userId,
        fileName: `f-${suffix()}`,
        type: KnowledgeType.FILE,
        filePath: `knowledge/${suffix()}`,
        mimeType,
        ...extra,
      })
    )._id
  );
const createSession = (fields: Record<string, unknown>) =>
  Session.create({ firstCreated: new Date(), lastUpdated: new Date(), ...fields });
const knowledgeIds = async (sessionId: string) =>
  ((await Session.findById(sessionId).lean()) as { knowledgeIds?: string[] }).knowledgeIds ?? [];

describe('file ids attached to an existing session persist across turns', () => {
  it('with persistFabFileIds, getOrCreateSession writes the new ids once, and a repeat is a no-op', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const pdf = await createFile(owner.id, 'application/pdf');
    const ability = defineAbilitiesFor(owner);
    const params = { sessionId: session.id, fabFileIds: [pdf], persistFabFileIds: true, user: owner, ability, logger };

    const first = await getOrCreateSession(params);
    expect(first.session.knowledgeIds).toEqual([pdf]);
    expect(await knowledgeIds(session.id)).toEqual([pdf]);

    const before = await Session.findById(session.id).lean();
    await getOrCreateSession(params);
    expect(await Session.findById(session.id).lean()).toEqual(before);
  });

  it('without the flag (the /api/ai/llm path), fabFileIds are per-turn and knowledgeIds is unchanged', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const pdf = await createFile(owner.id, 'application/pdf');
    const ability = defineAbilitiesFor(owner);

    await getOrCreateSession({ sessionId: session.id, fabFileIds: [pdf], user: owner, ability, logger });
    expect(await knowledgeIds(session.id)).toEqual([]);
  });

  it('keeps a detach the user makes while the attach turn is in flight', async () => {
    const owner = await createUser('owner');
    const kept = await createFile(owner.id, 'application/pdf');
    const detached = await createFile(owner.id, 'application/pdf');
    const incoming = await createFile(owner.id, 'application/pdf');
    const session = await createSession({ userId: owner.id, name: 'nb', knowledgeIds: [kept, detached] });

    // The user detaches `detached` in another tab between this turn's read of knowledgeIds and its
    // write. The metadata lookup sits inside that window, so interpose the detach there.
    const findMetadata = fabFileRepository.findMetadataByIds.bind(fabFileRepository);
    const spy = vi.spyOn(fabFileRepository, 'findMetadataByIds').mockImplementationOnce(async (ids, cap) => {
      await Session.updateOne({ _id: session.id }, { $pull: { knowledgeIds: detached } });
      return findMetadata(ids, cap);
    });

    try {
      await getOrCreateSession({
        sessionId: session.id,
        fabFileIds: [incoming],
        persistFabFileIds: true,
        user: owner,
        ability: defineAbilitiesFor(owner),
        logger,
      });
    } finally {
      spy.mockRestore();
    }

    expect(await knowledgeIds(session.id)).toEqual([kept, incoming]);
  });

  it('a read-only sharee gets NotFound and knowledgeIds is unchanged', async () => {
    const owner = await createUser('owner');
    const sharee = await createUser('sharee');
    const session = await createSession({
      userId: owner.id,
      name: 'shared',
      users: [{ userId: sharee.id, permissions: [Permission.read] }],
    });
    const pdf = await createFile(sharee.id, 'application/pdf');

    await expect(
      getOrCreateSession({
        sessionId: session.id,
        fabFileIds: [pdf],
        persistFabFileIds: true,
        user: sharee,
        ability: defineAbilitiesFor(sharee),
        logger,
      })
    ).rejects.toThrow('Session not found');
    expect(await knowledgeIds(session.id)).toEqual([]);
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
      [pdf, png]
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
      [foreignPdf]
    );

    expect(result.text).toBe('ok');
    expect(await knowledgeIds(session.id)).toEqual([]);
  });
});

describe('a message attachment is pinned to the session it was sent in', () => {
  const send = (owner: IUserDocument, sessionId: string, messageFileIds?: string[], messageOnlyFileIds?: string[]) =>
    getOrCreateSession({
      sessionId,
      messageFileIds,
      messageOnlyFileIds,
      user: owner,
      ability: defineAbilitiesFor(owner),
      logger,
    });

  it('keeps a file attached to a message available on later turns of the session', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const csv = await createFile(owner.id, 'text/csv');
    const png = await createFile(owner.id, 'image/png');

    const sent = await send(owner, session.id, [csv, png]);
    expect(sent.session.knowledgeIds).toEqual([csv]);

    // A later turn sends no attachment; the session still holds the file for the completion to read.
    const later = await send(owner, session.id);
    expect(later.session.knowledgeIds).toEqual([csv]);
    expect(await knowledgeIds(session.id)).toEqual([csv]);
  });

  it('does not pin files the sender cannot access', async () => {
    const owner = await createUser('owner');
    const stranger = await createUser('stranger');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const foreignPdf = await createFile(stranger.id, 'application/pdf');

    await send(owner, session.id, [foreignPdf]);
    expect(await knowledgeIds(session.id)).toEqual([]);
  });

  it('does not pin files the user scoped to this message only', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const pdf = await createFile(owner.id, 'application/pdf');

    await send(owner, session.id, [pdf], [pdf.toUpperCase()]);
    expect(await knowledgeIds(session.id)).toEqual([]);
  });

  it('pins only ids the message carries, whatever messageOnlyFileIds names', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const sent = await createFile(owner.id, 'application/pdf');
    const notSent = await createFile(owner.id, 'application/pdf');

    await send(owner, session.id, [sent], [notSent]);
    expect(await knowledgeIds(session.id)).toEqual([sent]);
  });

  it('seeds a new session with the message documents, never another user or a deleted file', async () => {
    const owner = await createUser('owner');
    const stranger = await createUser('stranger');
    const csv = await createFile(owner.id, 'text/csv');
    const png = await createFile(owner.id, 'image/png');
    const deleted = await createFile(owner.id, 'application/pdf', { deletedAt: new Date() });
    const foreign = await createFile(stranger.id, 'application/pdf');

    const created = await getOrCreateSession({
      sessionName: 'first message',
      messageFileIds: [csv, png, deleted, foreign],
      user: owner,
      ability: defineAbilitiesFor(owner),
      logger,
    });

    expect(created.wasCreated).toBe(true);
    expect(await knowledgeIds(created.sessionId)).toEqual([csv]);
  });

  it('does not pin a deleted file on an existing session', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const deleted = await createFile(owner.id, 'application/pdf', { deletedAt: new Date() });

    await send(owner, session.id, [deleted]);
    expect(await knowledgeIds(session.id)).toEqual([]);
  });

  it('leaves knowledgeIds unchanged on a view-only share and on another user session', async () => {
    const owner = await createUser('owner');
    const viewer = await createUser('viewer');
    const shared = await createSession({
      userId: owner.id,
      name: 'shared',
      users: [{ userId: viewer.id, permissions: [Permission.read] }],
    });
    const notShared = await createSession({ userId: owner.id, name: 'private' });
    const pdf = await createFile(viewer.id, 'application/pdf');

    await expect(send(viewer, shared.id, [pdf])).rejects.toThrow('Session not found');
    await expect(send(viewer, notShared.id, [pdf])).rejects.toThrow('Session not found');
    expect(await knowledgeIds(shared.id)).toEqual([]);
    expect(await knowledgeIds(notShared.id)).toEqual([]);
  });

  it('pins an agent-mode message attachment through the in-app door, and the REST door leaves it per-run', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const csv = await createFile(owner.id, 'text/csv');
    const png = await createFile(owner.id, 'image/png');
    const start = (pinMessageFiles: boolean) =>
      startAgentExecution(
        {
          userId: owner.id,
          sessionId: session.id,
          questId: session.id,
          query: 'summarize',
          model: 'claude-opus-5',
          connectionId: HEADLESS_CONNECTION_ID,
          apiKeyInfo: undefined,
          messageFileIds: [csv, png],
          pinMessageFiles,
        },
        logger
      );

    expect((await start(false)).ok).toBe(true);
    expect(await knowledgeIds(session.id)).toEqual([]);
    expect((await start(true)).ok).toBe(true);
    expect(await knowledgeIds(session.id)).toEqual([csv]);
  });

  it('pins a message attachment once, however often it is sent', async () => {
    const owner = await createUser('owner');
    const kept = await createFile(owner.id, 'application/pdf');
    const session = await createSession({ userId: owner.id, name: 'nb', knowledgeIds: [kept] });
    const pdf = await createFile(owner.id, 'application/pdf');

    await send(owner, session.id, [pdf, pdf.toUpperCase()]);
    const before = await Session.findById(session.id).lean();
    await send(owner, session.id, [pdf, kept]);

    expect(await Session.findById(session.id).lean()).toEqual(before);
    expect(await knowledgeIds(session.id)).toEqual([kept, pdf]);
  });

  it('lets the user remove a pinned message attachment from the session', async () => {
    const owner = await createUser('owner');
    const session = await createSession({ userId: owner.id, name: 'nb' });
    const pdf = await createFile(owner.id, 'application/pdf');
    await send(owner, session.id, [pdf]);

    // The Files panel removal: a full-list write without the file.
    await sessionService.updateSession(
      owner,
      { id: session.id, knowledgeIds: [] },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          caches: cacheRepository,
        },
        storage: {} as never,
      }
    );
    expect(await knowledgeIds(session.id)).toEqual([]);
  });
});
