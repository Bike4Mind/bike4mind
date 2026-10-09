// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { Session, User } from '@bike4mind/database';
import type { IUserDocument } from '@bike4mind/database';
import defineAbilitiesFor from '@server/auth/ability';
import { __resetResolvedPromptCache } from '@server/utils/sessionSystemPromptResolver';

/**
 * POST /api/ai/llm with a real session from Mongo. llm.integration.test.ts mocks the session
 * manager and the authored-prompt check, so a change in what getOrCreateSession hands back (a
 * plain object instead of a hydrated document, a renamed field) would slip past it. Here only the
 * LLM and queue boundaries are stubbed; the session lookup, the identity-prompt skip
 * (sessionWillInjectAuthoredPrompt) and redactSessionForClient all run for real.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { mockInvoke, mockLoadIdentityPrompts } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockLoadIdentityPrompts: vi.fn(),
}));

// Auth, scope and rate-limit middleware are covered by llm.integration.test.ts; skip the chain
// and call the route body directly.
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (handler: (...a: unknown[]) => unknown) => handler,
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/services/llm/ChatCompletionInvoke', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  ChatCompletionInvoke: class {
    invoke = (...a: unknown[]) => mockInvoke(...a);
  },
}));
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  SQSService: class {},
}));
vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({}),
  getSharedTokenizer: () => ({}),
}));
vi.mock('@server/utils/dispatchQuest', () => ({ dispatchQuest: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));

// Only the identity loader is stubbed, so its call is the observable for the skip. The rest of the
// module stays real: sessionWillInjectAuthoredPrompt resolves a systemPromptId through it.
vi.mock('@server/utils/systemPrompts/loader', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  loadBaseIdentitySystemPromptMessages: (...a: unknown[]) => mockLoadIdentityPrompts(...a),
}));

import handler from '../llm';

const IDENTITY_MESSAGE = { role: 'system', content: 'identity-sentinel' };

type JsonResponse = { quest: unknown; session: Record<string, unknown> };

let mongoServer: MongoMemoryServer;
let owner: IUserDocument;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  owner = (await User.create({
    name: 'owner',
    username: 'llm-route-owner',
    email: 'llm-route-owner@example.com',
  })) as unknown as IUserDocument;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetResolvedPromptCache();
  mockInvoke.mockResolvedValue({ id: 'quest-1', status: 'pending' });
  mockLoadIdentityPrompts.mockResolvedValue([IDENTITY_MESSAGE]);
});

const createSession = (fields: Record<string, unknown> = {}) =>
  Session.create({ firstCreated: new Date(), lastUpdated: new Date(), userId: owner.id, name: 'nb', ...fields });

/** Calls the route and returns the JSON body as it would cross the wire. */
const post = async (sessionId: string): Promise<JsonResponse> => {
  const json = vi.fn((payload: unknown) => payload);
  const status = vi.fn(() => ({ json }));
  const req = {
    user: owner,
    ability: defineAbilitiesFor(owner),
    headers: {},
    body: { sessionId, message: 'Hello there', historyCount: 10, fabFileIds: [], params: { model: 'gpt-4o' } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, { json, status });

  expect(status).not.toHaveBeenCalled();
  expect(json).toHaveBeenCalledTimes(1);
  return JSON.parse(JSON.stringify(json.mock.calls[0][0])) as JsonResponse;
};

const invokedContextMessages = (): unknown => {
  const [{ body }] = mockInvoke.mock.calls[0] as [{ body: { extraContextMessages?: unknown } }];
  return body.extraContextMessages;
};

describe('POST /api/ai/llm with a real session (Mongo)', () => {
  it('prepends the identity prompt for a session with no authored prompt', async () => {
    const session = await createSession();

    const response = await post(session.id);

    expect(mockLoadIdentityPrompts).toHaveBeenCalledTimes(1);
    expect(invokedContextMessages()).toEqual([IDENTITY_MESSAGE]);
    expect(response.session).toMatchObject({ id: session.id, name: 'nb' });
  });

  it('skips the identity prompt for a session with authored systemPromptText', async () => {
    const session = await createSession({ systemPromptText: 'You are the opti agent.' });

    await post(session.id);

    expect(mockLoadIdentityPrompts).not.toHaveBeenCalled();
    expect(invokedContextMessages()).toBeUndefined();
  });

  it('skips the identity prompt for a session bound to an activatable systemPromptId', async () => {
    // Resolved through the real registry lookup; with nothing seeded it falls back to the code default.
    const session = await createSession({ systemPromptId: 'triage_router' });

    await post(session.id);

    expect(mockLoadIdentityPrompts).not.toHaveBeenCalled();
    expect(invokedContextMessages()).toBeUndefined();
  });

  it('keeps the identity prompt when the bound systemPromptId is disabled in the registry', async () => {
    // Allowlisted but unresolvable: a membership-only check would skip the identity here while the
    // completion path injects nothing, leaving the session with no system prompt at all.
    await mongoose.model('SystemPrompt').create({
      promptId: 'triage_router',
      name: 'Triage router',
      description: 'Routes triage requests',
      content: 'Route the request',
      category: 'general',
      enabled: false,
      createdBy: owner.id,
      lastUpdatedBy: owner.id,
      lastUpdatedByName: 'owner',
    });
    const session = await createSession({ systemPromptId: 'triage_router' });

    try {
      await post(session.id);
    } finally {
      await mongoose.model('SystemPrompt').deleteMany({});
    }

    expect(mockLoadIdentityPrompts).toHaveBeenCalledTimes(1);
    expect(invokedContextMessages()).toEqual([IDENTITY_MESSAGE]);
  });

  it('redacts server-owned fields from the session it returns', async () => {
    const session = await createSession({
      systemPromptText: 'You are the opti agent.',
      preauthorizedLakeIds: ['lake-1'],
      origin: { channel: 'api', apiKeyId: 'key-1' },
    });

    const response = await post(session.id);

    expect(response.session).toMatchObject({ id: session.id, name: 'nb', origin: { channel: 'api' } });
    expect(response.session).not.toHaveProperty('systemPromptText');
    expect(response.session).not.toHaveProperty('preauthorizedLakeIds');
    expect(response.session.origin).not.toHaveProperty('apiKeyId');
  });
});
