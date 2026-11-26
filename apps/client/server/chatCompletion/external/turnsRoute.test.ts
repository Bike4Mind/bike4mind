import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';

vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    updateMetadata = vi.fn();
  },
  describeErrorCause: () => undefined,
}));

const db = vi.hoisted(() => ({
  findUser: vi.fn(),
  findQuest: vi.fn(),
  updateUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  mongoose: {
    connection: { readyState: 1 },
    isValidObjectId: (id: string) => /^[0-9a-f]{24}$/.test(id),
  },
  User: { findById: db.findUser },
  questRepository: { findById: db.findQuest },
  spendFreezeRepository: {},
  usageEventRepository: {},
  userRepository: { update: db.updateUser },
}));

// Reached through sseRoute's helpers; their real modules define mongoose models.
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('@bike4mind/services/cliCompletions', () => ({ executeCompletion: vi.fn() }));

vi.mock('@bike4mind/services/creditService', () => ({ assertSpendNotFrozen: vi.fn() }));

type InvokeArgs = { body: Record<string, unknown>; userId: string };
const invoke = vi.hoisted(() => ({
  options: undefined as undefined | { invokeLambda: (params: unknown) => Promise<void> },
  fn: vi.fn(),
}));
vi.mock('@bike4mind/services/llm/ChatCompletionInvoke', () => ({
  ChatCompletionInvoke: class {
    constructor(options: { invokeLambda: (params: unknown) => Promise<void> }) {
      invoke.options = options;
    }
    invoke(args: InvokeArgs) {
      return invoke.fn(args);
    }
  },
}));

const forwardSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  ClientMessageSender: class {
    sendToClient = forwardSend;
  },
  SQSService: class {},
}));

vi.mock('@bike4mind/server-utils/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@bike4mind/server-utils/auth/adminRoles', () => ({ resolveRoleAdminPermissions: vi.fn() }));
vi.mock('@bike4mind/server-utils/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@bike4mind/server-utils/billing/freeTierDailyCapGate', () => ({ checkFreeTierDailySpendCap: vi.fn() }));
vi.mock('@bike4mind/server-utils/cli/auth', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));
const resolveContractAuth = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/cli/resolveContractAuth', () => ({ resolveContractAuth }));
vi.mock('@bike4mind/server-utils/dataLakes/dataLakeScopes', () => ({ dataLakeToolsDeniedFor: () => [] }));
const getOrCreateSession = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/managers/sessionManager', () => ({ getOrCreateSession }));
vi.mock('@bike4mind/server-utils/middlewares/clientVersionGate', () => ({
  checkClientVersion: vi.fn().mockResolvedValue(null),
}));
vi.mock('@bike4mind/server-utils/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({}),
  getSharedTokenizer: () => ({}),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'x', STAGE: 'test' } }));
vi.mock('@bike4mind/server-utils/utils/sessionSystemPromptResolver', () => ({
  sessionWillInjectAuthoredPrompt: vi.fn().mockResolvedValue(true),
}));
vi.mock('@bike4mind/server-utils/utils/systemPrompts/loader', () => ({
  loadBaseIdentitySystemPromptMessages: vi.fn().mockResolvedValue([]),
}));
const quotaRelease = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/server-utils/utils/untrustedCompletionQuota', () => ({
  NO_COMPLETION_QUOTA: { release: () => Promise.resolve() },
  admitRequestCompletion: vi.fn(async () => ({ release: quotaRelease })),
}));
vi.mock('@server/billing/apiKeyBillingOrg', () => ({ resolveRequestBillingOrgId: vi.fn().mockResolvedValue(null) }));
vi.mock('@server/managers/sessionOrigin', () => ({ resolveSessionOrigin: () => ({ channel: 'api' }) }));
const processQuest = vi.hoisted(() => vi.fn());
vi.mock('@server/queueHandlers/questProcessor', () => ({
  getStaticOptions: () => ({ db: {} }),
  processQuest,
}));
const handleQuestProcessingFailure = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../internal/route', () => ({ handleQuestProcessingFailure }));
vi.mock('./apiKeyUsageLog', () => ({ logApiKeyUsageOnResponse: vi.fn().mockResolvedValue(undefined) }));

import { UnauthorizedError, NotFoundError, SessionTurnStreamEventSchema } from '@bike4mind/common';
import type { ClientFrameSender } from '@bike4mind/services/llm';
import { registerTurnsRoutes } from './turnsRoute';

const SESSION_ID = 'a'.repeat(24);
const QUEST_ID = 'b'.repeat(24);
const USER = { id: 'user-1' };
const VALID_BODY = { session_id: SESSION_ID, message: 'hi', model: 'claude-opus-4-8' };

let server: Server;
let baseUrl: string;
let tracked: Promise<void>[] = [];

beforeAll(async () => {
  const app = express();
  registerTurnsRoutes(app, promise => tracked.push(promise));
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});
afterAll(() => server?.close());

function frame(quest: Record<string, unknown>) {
  return { action: 'streamed_chat_completion' as const, quest: { id: QUEST_ID, ...quest } };
}

function sendFrame(sender: ClientFrameSender, quest: Record<string, unknown>) {
  // The frame union is wide; the route only reads this one action.
  return sender.sendToClient(USER.id, 'wss://x', frame(quest) as Parameters<ClientFrameSender['sendToClient']>[2]);
}

function post(body: unknown) {
  return fetch(`${baseUrl}/api/v1/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

function parseEvents(text: string) {
  return text
    .split('\n\n')
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => chunk.slice('data: '.length));
}

beforeEach(() => {
  vi.clearAllMocks();
  tracked = [];
  resolveContractAuth.mockResolvedValue({ method: 'jwt', userId: USER.id, user: { user: USER } });
  getOrCreateSession.mockResolvedValue({ session: { id: SESSION_ID }, sessionId: SESSION_ID, asyncPromises: [] });
  invoke.fn.mockImplementation(async () => {
    await invoke.options?.invokeLambda({ questId: QUEST_ID, sessionId: SESSION_ID, userId: USER.id });
    return { id: QUEST_ID };
  });
  db.findQuest.mockResolvedValue({ status: 'done', replies: ['Hello world'], creditsUsed: 3 });
});

describe('POST /api/v1/turns', () => {
  it('answers a bad credential with a JSON 401 before any stream', async () => {
    resolveContractAuth.mockRejectedValue(new UnauthorizedError('nope'));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(getOrCreateSession).not.toHaveBeenCalled();
    expect(processQuest).not.toHaveBeenCalled();
  });

  it('answers an inaccessible session with 404 and never creates one', async () => {
    getOrCreateSession.mockRejectedValue(new NotFoundError('Session not found'));

    const res = await post(VALID_BODY);

    expect(res.status).toBe(404);
    expect(getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID }));
    expect(invoke.fn).not.toHaveBeenCalled();
  });

  it('answers a malformed session id with 404 without a lookup', async () => {
    const res = await post({ ...VALID_BODY, session_id: 'not-an-id' });

    expect(res.status).toBe(404);
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it('answers a body that fails validation with 422', async () => {
    const res = await post({ session_id: SESSION_ID, model: 'claude-opus-4-8' });

    expect(res.status).toBe(422);
    expect(resolveContractAuth).not.toHaveBeenCalled();
  });

  it('streams meta, turn, slot events and settled, then [DONE], in order', async () => {
    processQuest.mockImplementation(async (_params, _logger, { clientMessageSender }) => {
      await sendFrame(clientMessageSender, { status: 'running', replies: ['Hello'] });
      await sendFrame(clientMessageSender, { status: 'running', replies: ['Hello wor'] });
      await sendFrame(clientMessageSender, { status: 'done', replies: ['Hello world'] });
    });

    const res = await post(VALID_BODY);
    const events = parseEvents(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events.at(-1)).toBe('[DONE]');
    const parsed = events.slice(0, -1).map(event => SessionTurnStreamEventSchema.parse(JSON.parse(event)));
    expect(parsed.map(event => event.type)).toEqual(['meta', 'turn', 'delta', 'delta', 'delta', 'settled']);
    expect(parsed[1]).toEqual({ type: 'turn', questId: QUEST_ID, sessionId: SESSION_ID });
    expect(parsed.slice(2, 5).map(event => ('text' in event ? event.text : ''))).toEqual(['Hello', ' wor', 'ld']);
    expect(parsed[5]).toEqual({ type: 'settled', questId: QUEST_ID, status: 'done', creditsUsed: 3 });
    // The web app keeps getting every frame over the websocket.
    expect(forwardSend).toHaveBeenCalledTimes(3);
    expect(invoke.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          sessionId: SESSION_ID,
          message: 'hi',
          historyCount: 10,
          params: { model: 'claude-opus-4-8' },
        }),
      })
    );
    expect(quotaRelease).toHaveBeenCalledTimes(1);
  });

  it('settles from the stored quest when invoke refused the turn without dispatching it', async () => {
    invoke.fn.mockResolvedValue({ id: QUEST_ID });
    db.findQuest.mockResolvedValue({ status: 'done', reply: 'No credits', errorCode: 'insufficient_credits' });

    const res = await post(VALID_BODY);
    const events = parseEvents(await res.text())
      .slice(0, -1)
      .map(event => JSON.parse(event));

    expect(processQuest).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: 'settled',
      questId: QUEST_ID,
      status: 'done',
      errorCode: 'insufficient_credits',
    });
  });

  it('keeps the turn running when the client disconnects', async () => {
    let finish: () => void = () => {};
    let sender: ClientFrameSender | undefined;
    let options: { abortSignal?: AbortSignal } | undefined;
    const started = new Promise<void>(resolveStarted => {
      processQuest.mockImplementation(async (_params, _logger, opts) => {
        options = opts;
        sender = opts.clientMessageSender;
        resolveStarted();
        await new Promise<void>(resolve => {
          finish = resolve;
        });
      });
    });

    const res = await post(VALID_BODY);
    await started;
    await res.body?.cancel();

    await sendFrame(sender!, { status: 'running', replies: ['still going'] });
    finish();
    await Promise.all(tracked);

    expect(options?.abortSignal).toBeUndefined();
    expect(forwardSend).toHaveBeenCalledTimes(1);
    expect(handleQuestProcessingFailure).not.toHaveBeenCalled();
    expect(quotaRelease).toHaveBeenCalledTimes(1);
  });

  it('settles the quest and still closes the stream when processing throws', async () => {
    const failure = new Error('boom');
    processQuest.mockRejectedValue(failure);
    db.findQuest.mockResolvedValue({ status: 'stopped', replies: ['Something went wrong'] });

    const res = await post(VALID_BODY);
    const events = parseEvents(await res.text());

    expect(handleQuestProcessingFailure).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ questId: QUEST_ID, surface: 'session-turns' })
    );
    expect(JSON.parse(events.at(-2)!)).toEqual({ type: 'settled', questId: QUEST_ID, status: 'stopped' });
    expect(events.at(-1)).toBe('[DONE]');
  });

  it('answers another verb with 405', async () => {
    const res = await fetch(`${baseUrl}/api/v1/turns`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
