import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

/**
 * Ownership scoping for the history-import upserts.
 *
 * The external conversation id is client-controlled (it comes straight from an uploaded
 * ChatGPT/Claude export). Both upsertBy*ConversationId methods must scope their filter to
 * the importing user, otherwise a forged id colliding with another user's session would
 * match that row and silently re-own it (overwriting userId, name, timestamps). No unique
 * index exists on either conversation-id field, so a cross-tenant collision must fall
 * through to insert a fresh row for the importer instead.
 */
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
});

const bTimes = { firstCreated: new Date('2020-01-01'), lastUpdated: new Date('2020-02-01') };
const aTimes = { firstCreated: new Date('2023-01-01'), lastUpdated: new Date('2023-02-01') };

describe('SessionRepository.upsertByOpenaiConversationId scopes to the owner', () => {
  it('does not re-own another user B session when A imports a colliding conversation id', async () => {
    const bSession = await sessionRepository.upsertByOpenaiConversationId('conv-shared', {
      userId: 'userB',
      name: 'B notebook',
      openaiConversationId: 'conv-shared',
      ...bTimes,
    });

    const aSession = await sessionRepository.upsertByOpenaiConversationId('conv-shared', {
      userId: 'userA',
      name: 'A notebook',
      openaiConversationId: 'conv-shared',
      ...aTimes,
    });

    // A gets its own, separate row.
    expect(aSession.id).not.toBe(bSession.id);
    expect(aSession.userId).toBe('userA');

    // B's row is untouched: owner, name, and timestamps intact.
    const bFresh = await Session.findById(bSession.id);
    expect(bFresh!.userId).toBe('userB');
    expect(bFresh!.name).toBe('B notebook');
    expect(bFresh!.firstCreated.getTime()).toBe(bTimes.firstCreated.getTime());
    expect(bFresh!.lastUpdated.getTime()).toBe(bTimes.lastUpdated.getTime());

    // Two distinct rows now share the conversation id.
    expect(await Session.countDocuments({ openaiConversationId: 'conv-shared' })).toBe(2);
  });

  it('still updates a user own record on legitimate re-import (no over-denial)', async () => {
    const first = await sessionRepository.upsertByOpenaiConversationId('conv-mine', {
      userId: 'userA',
      name: 'Old name',
      openaiConversationId: 'conv-mine',
      ...aTimes,
    });

    const second = await sessionRepository.upsertByOpenaiConversationId('conv-mine', {
      userId: 'userA',
      name: 'New name',
      openaiConversationId: 'conv-mine',
      ...aTimes,
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('New name');
    expect(await Session.countDocuments({ openaiConversationId: 'conv-mine' })).toBe(1);
  });

  it('throws when userId is missing so ownership can never be unscoped', async () => {
    await expect(
      sessionRepository.upsertByOpenaiConversationId('conv-x', {
        name: 'no owner',
        openaiConversationId: 'conv-x',
        ...aTimes,
      })
    ).rejects.toThrow(/userId/);
  });
});

describe('SessionRepository.upsertByClaudeConversationId scopes to the owner', () => {
  it('does not re-own another user B session when A imports a colliding conversation id', async () => {
    const bSession = await sessionRepository.upsertByClaudeConversationId('claude-shared', {
      userId: 'userB',
      name: 'B notebook',
      claudeConversationId: 'claude-shared',
      ...bTimes,
    });

    const aSession = await sessionRepository.upsertByClaudeConversationId('claude-shared', {
      userId: 'userA',
      name: 'A notebook',
      claudeConversationId: 'claude-shared',
      ...aTimes,
    });

    expect(aSession.id).not.toBe(bSession.id);
    expect(aSession.userId).toBe('userA');

    const bFresh = await Session.findById(bSession.id);
    expect(bFresh!.userId).toBe('userB');
    expect(bFresh!.name).toBe('B notebook');
    expect(bFresh!.firstCreated.getTime()).toBe(bTimes.firstCreated.getTime());
    expect(bFresh!.lastUpdated.getTime()).toBe(bTimes.lastUpdated.getTime());

    expect(await Session.countDocuments({ claudeConversationId: 'claude-shared' })).toBe(2);
  });

  it('throws when userId is missing so ownership can never be unscoped', async () => {
    await expect(
      sessionRepository.upsertByClaudeConversationId('claude-x', {
        name: 'no owner',
        claudeConversationId: 'claude-x',
        ...aTimes,
      })
    ).rejects.toThrow(/userId/);
  });
});
