import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Session, Quest } from '@bike4mind/database';
import { resolveFeedbackContext } from '../feedbackContext';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const stubLogger = () => ({ warn: vi.fn() });

async function makeOwnedQuest(ownerId: string) {
  const session = await Session.create({
    name: 'a session',
    userId: ownerId,
    lastUpdated: new Date(),
    firstCreated: new Date(),
  });
  const quest = await Quest.create({
    sessionId: session.id,
    timestamp: new Date(),
    type: 'message',
    prompt: 'hello',
  });
  return { session, quest };
}

describe('resolveFeedbackContext', () => {
  it('returns null org and drops all claims for an unauthenticated submitter', async () => {
    const context = await resolveFeedbackContext({
      authenticatedUserId: undefined,
      organizationId: 'some-org-id',
      claims: { questId: 'anything', sessionId: 'anything' },
      logger: stubLogger(),
    });
    expect(context).toEqual({ organizationId: null, subject: 'product' });
  });

  it('resolves questId/sessionId/subject when the caller owns the quest', async () => {
    const { session, quest } = await makeOwnedQuest('owner-1');

    const context = await resolveFeedbackContext({
      authenticatedUserId: 'owner-1',
      organizationId: 'org-1',
      claims: { questId: quest.id },
      logger: stubLogger(),
    });

    expect(context).toEqual({
      questId: quest.id,
      sessionId: session.id,
      organizationId: 'org-1',
      subject: 'turn',
    });
  });

  it('drops questId when the quest belongs to a different user, keeping organizationId', async () => {
    const { quest } = await makeOwnedQuest('owner-2');
    const logger = stubLogger();

    const context = await resolveFeedbackContext({
      authenticatedUserId: 'stranger',
      organizationId: 'org-1',
      claims: { questId: quest.id },
      logger,
    });

    expect(context).toEqual({ organizationId: 'org-1', subject: 'product' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('allows a shared session user, not just the owner', async () => {
    const session = await Session.create({
      name: 'shared session',
      userId: 'owner-3',
      users: [{ userId: 'shared-viewer', permissions: [] }],
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });
    const quest = await Quest.create({
      sessionId: session.id,
      timestamp: new Date(),
      type: 'message',
      prompt: 'hi',
    });

    const context = await resolveFeedbackContext({
      authenticatedUserId: 'shared-viewer',
      organizationId: 'org-1',
      claims: { questId: quest.id },
      logger: stubLogger(),
    });

    expect(context.questId).toBe(quest.id);
    expect(context.subject).toBe('turn');
  });

  it('falls back to a bare sessionId claim when no quest is given', async () => {
    const session = await Session.create({
      name: 'session only',
      userId: 'owner-4',
      lastUpdated: new Date(),
      firstCreated: new Date(),
    });

    const context = await resolveFeedbackContext({
      authenticatedUserId: 'owner-4',
      organizationId: 'org-1',
      claims: { sessionId: session.id },
      logger: stubLogger(),
    });

    expect(context).toEqual({ sessionId: session.id, organizationId: 'org-1', subject: 'session' });
  });

  it('drops a missing quest without throwing', async () => {
    const context = await resolveFeedbackContext({
      authenticatedUserId: 'owner-5',
      organizationId: 'org-1',
      claims: { questId: new mongoose.Types.ObjectId().toString() },
      logger: stubLogger(),
    });
    expect(context).toEqual({ organizationId: 'org-1', subject: 'product' });
  });

  it('drops a junk (non-ObjectId) questId without throwing a CastError', async () => {
    const logger = stubLogger();
    const context = await resolveFeedbackContext({
      authenticatedUserId: 'owner-6',
      organizationId: 'org-1',
      claims: { questId: 'not-an-objectid' },
      logger,
    });
    expect(context).toEqual({ organizationId: 'org-1', subject: 'product' });
    expect(logger.warn).toHaveBeenCalled();
  });
});
