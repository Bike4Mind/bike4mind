// @vitest-environment node
/**
 * Drives the real voice v2 llm-proxy handler with every heavy dependency
 * (baseApi's middleware chain, ChatCompletionInvoke/Process, the DB repositories,
 * the voice SSE helpers) mocked out, so the assertion below is only about the
 * body this handler builds - not about auth, streaming, or persistence.
 *
 * What this pins: `runFullPipeline`'s invoke/process body always carries
 * `deniedTools: [...DATA_LAKE_TOOL_NAMES]` (completions.ts line ~149). Without it,
 * a save-intent voice utterance could reach the data-lake write tools past the
 * curated VOICE_BUILTIN_TOOLS allowlist. The expected array is hardcoded here
 * (not imported from @bike4mind/common) so a change to the constant's contents
 * also fails this test, not just a deletion of the line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockVerifyVoiceSessionToken,
  mockFindDuplicateQuests,
  mockUserFindById,
  mockGetSettingsMap,
  mockInvoke,
  mockProcess,
  mockWriteStaticCompletion,
  mockInvokeOptions,
  mockOptionsFindUser,
  mockSseChunk,
  processState,
} = vi.hoisted(() => ({
  mockVerifyVoiceSessionToken: vi.fn(),
  mockFindDuplicateQuests: vi.fn(),
  mockUserFindById: vi.fn(),
  mockGetSettingsMap: vi.fn(),
  mockInvoke: vi.fn(),
  mockProcess: vi.fn(),
  mockWriteStaticCompletion: vi.fn(),
  mockInvokeOptions: vi.fn(),
  mockOptionsFindUser: vi.fn(),
  mockSseChunk: vi.fn(),
  processState: { terminalError: undefined as Error | undefined },
}));

// Bypass baseApi's whole middleware chain (connectDB, passport, api-key auth) - this
// route only cares about the body its own handler builds, and `.post()` here hands
// back the raw handler so tests can call it directly. Mirrors
// pages/api/data-lakes/__tests__/semantic-search.test.ts.
// The real billing helpers read repositories (and mongoose models via entitlements) the database mock lacks.
vi.mock('@server/billing/meterPlatformCompletion', () => ({ createCompletionMeter: vi.fn() }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn().mockResolvedValue([]) }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: (...args: unknown[]) => unknown) => handler;
    return chain;
  },
}));

vi.mock('@server/voice/voiceSessionToken', () => ({
  verifyVoiceSessionToken: (...args: unknown[]) => mockVerifyVoiceSessionToken(...args),
}));

vi.mock('@server/premium-generated/premiumLlmTools.generated', () => ({ premiumLlmTools: {} }));

// The wiring module reads infra Resources at load; the resolver is the unit under test, not the job engine.
const mockBuildVideoToolConfig = vi.fn();
vi.mock('@server/generationJobs/wiring', () => ({
  getVideoJobDeps: () => ({ deps: 'availability' }),
  getCreateVideoJobDeps: () => ({ deps: 'create' }),
}));
vi.mock('@bike4mind/server-utils/videoGenerations/buildVideoToolConfig', () => ({
  buildVideoToolConfig: (...args: unknown[]) => mockBuildVideoToolConfig(...args),
}));

vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({ db: { users: { findById: mockOptionsFindUser } } }),
  getSharedTokenizer: () => ({}),
}));

const mockRecordVoiceActivity = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  sessionRepository: {
    recordVoiceActivity: (...args: unknown[]) => mockRecordVoiceActivity(...args),
  },
  questRepository: {
    findAllBySessionIdAndGreaterThanOrEqualToTimestamp: (...args: unknown[]) => mockFindDuplicateQuests(...args),
    markStopped: vi.fn().mockResolvedValue(undefined),
  },
  userRepository: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}));

vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => mockGetSettingsMap(...args),
  getSettingsValue: () => undefined,
}));

vi.mock('@bike4mind/services/llm', () => ({
  // Type-only in the real module (used only as generic parameters in completions.ts);
  // kept here only so an accidental value reference does not throw.
  ChatCompletionFeature: {},
  featureNames: {},
  ChatCompletionInvoke: class {
    constructor(options: unknown) {
      mockInvokeOptions(options);
    }
    prefetchedSession = undefined;
    prefetchedOrganization = undefined;
    invoke = (...args: unknown[]) => mockInvoke(...args);
  },
  ChatCompletionProcess: class {
    terminalError = processState.terminalError;
    process = (...args: unknown[]) => mockProcess(...args);
  },
}));

vi.mock('@bike4mind/voice', () => ({
  buildClientToolPassthrough: () => ({}),
  currentTurnUserMessage: () => 'hello there',
  diffAccumulated: (sent: string, visible: string) => visible.slice(sent.length),
  extractSystemPrompt: () => '',
  emitInitialBuffer: () => {},
  openAiSseChunk: (...args: unknown[]) => {
    mockSseChunk(...args);
    return 'chunk';
  },
  openAiSseDone: () => 'done',
  stripSpokenThinking: (text: string) => text,
  writeStaticCompletion: (...args: unknown[]) => mockWriteStaticCompletion(...args),
}));

import handler from '../completions';
import { VOICE_SESSION_TOKEN_TTL_SECONDS } from '@bike4mind/server-utils/voice/voiceSessionLimits';

// Minimal SSE-response double: only setHeader/write/end/on are ever touched by the
// success path this test drives.
function makeRes() {
  let writableEnded = false;
  return {
    setHeader: () => {},
    flushHeaders: () => {},
    write: () => true,
    end: () => {
      writableEnded = true;
    },
    on: () => {},
    get writableEnded() {
      return writableEnded;
    },
  };
}

function makeReq() {
  return {
    body: { elevenlabs_extra_body: { b4m_session: 'signed-session-token' }, messages: [] },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

// A hold opened a minute ago: inside the window its token may be served for.
const recentHold = () => new Date(Date.now() - 60_000).toISOString();

function primeSuccessfulTurn() {
  vi.clearAllMocks();
  mockVerifyVoiceSessionToken.mockReturnValue({
    userId: 'user-1',
    sessionId: 'session-1',
    organizationId: undefined,
    reasoningModelId: 'test-model',
    authOrigin: 'session',
    voiceHoldStartedAt: recentHold(),
  });
  mockFindDuplicateQuests.mockResolvedValue([]);
  mockRecordVoiceActivity.mockResolvedValue(true);
  mockUserFindById.mockResolvedValue({ id: 'user-1' });
  mockGetSettingsMap.mockResolvedValue({});
  mockInvoke.mockResolvedValue({ id: 'quest-1', replies: [], reply: '' });
  mockProcess.mockResolvedValue(undefined);
  processState.terminalError = undefined;
}

describe('POST /api/voice/v2/llm-proxy/chat/completions - deniedTools', () => {
  beforeEach(primeSuccessfulTurn);

  it('denies the data-lake tools on both the invoke and process bodies', async () => {
    const req = makeReq();
    const res = makeRes();

    await handler(req as never, res as never);

    const expected = ['list_my_data_lakes', 'create_data_lake', 'save_content_to_data_lake'];
    expect((mockInvoke.mock.calls[0][0] as { body: { deniedTools?: string[] } }).body.deniedTools).toEqual(expected);
    expect((mockProcess.mock.calls[0][0] as { body: { deniedTools?: string[] } }).body.deniedTools).toEqual(expected);
  });

  // A fixed budget reads as a caller choice, so the model-aware default never applies and a
  // reasoning model spends the whole 4096 thinking.
  it('sends no fixed max_tokens, so the budget is sized per model', async () => {
    await handler(makeReq() as never, makeRes() as never);

    type Body = { body: { params: Record<string, unknown> } };
    for (const call of [mockInvoke.mock.calls[0][0], mockProcess.mock.calls[0][0]] as Body[]) {
      expect(call.body.params).not.toHaveProperty('max_tokens');
    }
  });

  // Speech streams from the raw reply, so a choices block would be read aloud.
  it('withholds the reply-choices guidance on both the invoke and process bodies', async () => {
    await handler(makeReq() as never, makeRes() as never);

    type Body = { body: { skipReplyChoices?: boolean; skipAutoOffers?: boolean } };
    for (const call of [mockInvoke.mock.calls[0][0], mockProcess.mock.calls[0][0]] as Body[]) {
      expect(call.body.skipReplyChoices).toBe(true);
      // Narrow on purpose: skipAutoOffers would also drop the knowledge and MCP offers voice uses.
      expect(call.body.skipAutoOffers).toBeUndefined();
    }
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - turn auth', () => {
  beforeEach(primeSuccessfulTurn);

  type InvokeArg = { authOrigin?: string; apiKeyId?: string };
  type ProcessArg = { body: { authOrigin?: string; apiKeyId?: string } };

  // A session-only tool reads ToolContext.authOrigin, which process() takes from its body; invoke()
  // carries it (and the key id) for the quest record.
  it('forwards the key that minted the token to invoke() and the process() body', async () => {
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
      authOrigin: 'apiKey',
      apiKeyId: 'key-1',
      voiceHoldStartedAt: recentHold(),
    });

    await handler(makeReq() as never, makeRes() as never);

    expect(mockInvoke.mock.calls[0][0] as InvokeArg).toEqual(
      expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'key-1' })
    );
    expect((mockProcess.mock.calls[0][0] as ProcessArg).body).toEqual(
      expect.objectContaining({ authOrigin: 'apiKey', apiKeyId: 'key-1' })
    );
  });

  it('forwards a session origin and no key id for a token minted by a signed-in session', async () => {
    await handler(makeReq() as never, makeRes() as never);

    expect((mockInvoke.mock.calls[0][0] as InvokeArg).authOrigin).toBe('session');
    expect((mockInvoke.mock.calls[0][0] as InvokeArg).apiKeyId).toBeUndefined();
    expect((mockProcess.mock.calls[0][0] as ProcessArg).body.authOrigin).toBe('session');
    expect((mockProcess.mock.calls[0][0] as ProcessArg).body.apiKeyId).toBeUndefined();
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - owner admin role', () => {
  beforeEach(primeSuccessfulTurn);

  const turnWith = async (adminRoleWithheld: boolean | undefined) => {
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
      authOrigin: 'apiKey',
      apiKeyId: 'key-1',
      voiceHoldStartedAt: recentHold(),
      ...(adminRoleWithheld === undefined ? {} : { adminRoleWithheld }),
    });
    mockUserFindById.mockResolvedValue({ id: 'user-1', isAdmin: true });
    await handler(makeReq() as never, makeRes() as never);
    return (mockInvokeOptions.mock.calls[0][0] as { user: { isAdmin: boolean } }).user;
  };

  it('withholds the admin role when the token says the minting key lacked the admin scope', async () => {
    expect((await turnWith(true)).isAdmin).toBe(false);
  });

  it('keeps the admin role when the token carries no such claim', async () => {
    expect((await turnWith(undefined)).isAdmin).toBe(true);
  });

  it.each([
    ['withholds', true, false],
    ['keeps', undefined, true],
  ])('%s the admin role from a tool that re-reads the owner by id', async (_, adminRoleWithheld, expected) => {
    await turnWith(adminRoleWithheld);
    const { users } = (mockInvokeOptions.mock.calls[0][0] as { db: { users: { findById: (id: string) => unknown } } })
      .db;
    mockOptionsFindUser.mockResolvedValueOnce({ id: 'user-1', isAdmin: true });
    expect(((await users.findById('user-1')) as { isAdmin?: boolean }).isAdmin).toBe(expected);
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - video generation', () => {
  beforeEach(primeSuccessfulTurn);

  type VideoBody = { body: { tools?: string[] } };
  type VideoProcessArg = VideoBody & { videoToolConfigResolver?: () => Promise<unknown> };

  it('offers video_generation on both bodies and hands process() a resolver carrying the on-screen delivery note', async () => {
    const config = { usableModels: ['test-video'], createJob: vi.fn() };
    mockBuildVideoToolConfig.mockResolvedValue(config);

    await handler(makeReq() as never, makeRes() as never);

    expect((mockInvoke.mock.calls[0][0] as VideoBody).body.tools).toContain('video_generation');
    const processArg = mockProcess.mock.calls[0][0] as VideoProcessArg;
    expect(processArg.body.tools).toContain('video_generation');
    // The handler only hands over the resolver; process() (mocked here) is what runs the usable-model lookup.
    expect(mockBuildVideoToolConfig).not.toHaveBeenCalled();
    expect(await processArg.videoToolConfigResolver?.()).toEqual({
      ...config,
      createJob: expect.any(Function),
      deliveryNote: expect.stringContaining('appears on screen in this session chat'),
    });
    expect(mockBuildVideoToolConfig).toHaveBeenCalledWith('user-1', {
      availability: { deps: 'availability' },
      createDeps: { deps: 'create' },
    });
  });

  it('does not offer the tool, or a resolver, to a call minted by an API key', async () => {
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
      authOrigin: 'apiKey',
      apiKeyId: 'key-1',
      voiceHoldStartedAt: recentHold(),
    });

    await handler(makeReq() as never, makeRes() as never);

    expect((mockInvoke.mock.calls[0][0] as VideoBody).body.tools).not.toContain('video_generation');
    const processArg = mockProcess.mock.calls[0][0] as VideoProcessArg;
    expect(processArg.body.tools).not.toContain('video_generation');
    expect(processArg.videoToolConfigResolver).toBeUndefined();
    expect(mockBuildVideoToolConfig).not.toHaveBeenCalled();
  });

  it('keeps the inline built-ins alongside the video tool', async () => {
    await handler(makeReq() as never, makeRes() as never);

    expect((mockProcess.mock.calls[0][0] as VideoBody).body.tools).toEqual(
      expect.arrayContaining(['web_search', 'search_knowledge_base', 'video_generation'])
    );
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - duplicate turns', () => {
  beforeEach(primeSuccessfulTurn);

  // currentTurnUserMessage is mocked to 'hello there'
  const quest = (overrides: Record<string, unknown>) => ({ prompt: 'hello there', status: 'done', ...overrides });

  it('drops a retry while the original turn is still running, speaking nothing', async () => {
    mockFindDuplicateQuests.mockResolvedValue([quest({ status: 'running' })]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockWriteStaticCompletion).toHaveBeenCalledWith(expect.anything(), expect.anything(), '');
  });

  // A dropped connection stops the quest but leaves the billed video job its tool call already created.
  it('drops a retry of a stopped turn that already started a video job, and says so', async () => {
    mockFindDuplicateQuests.mockResolvedValue([
      quest({ status: 'stopped', generationJobs: [{ id: 'job-1', kind: 'video' }] }),
    ]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWriteStaticCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('already being made')
    );
  });

  it('drops a retry of a stopped turn that claimed a video start before its job ref was written', async () => {
    mockFindDuplicateQuests.mockResolvedValue([quest({ status: 'stopped', agentVideoClipsClaimed: 1 })]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockProcess).not.toHaveBeenCalled();
    expect(mockWriteStaticCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('already being made')
    );
  });

  it('also recognizes a video job recorded on the legacy videoJobIds field', async () => {
    mockFindDuplicateQuests.mockResolvedValue([quest({ status: 'stopped', videoJobIds: ['job-1'] })]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('still answers a retry of a stopped turn that never started a job', async () => {
    mockFindDuplicateQuests.mockResolvedValue([quest({ status: 'stopped' })]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it('still answers an identical repeat of a done turn that started a video job', async () => {
    mockFindDuplicateQuests.mockResolvedValue([
      quest({ status: 'done', generationJobs: [{ id: 'job-1', kind: 'video' }] }),
    ]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  it('still answers the same words after a non-video job, or a video job on a different prompt', async () => {
    mockFindDuplicateQuests.mockResolvedValue([
      quest({ status: 'stopped', generationJobs: [{ id: 'song-1', kind: 'music' }] }),
      quest({ prompt: 'something else', status: 'stopped', generationJobs: [{ id: 'job-2', kind: 'video' }] }),
    ]);

    await handler(makeReq() as never, makeRes() as never);

    expect(mockProcess).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - voice activity', () => {
  beforeEach(primeSuccessfulTurn);

  it("marks the token's session connected and alive on every verified turn", async () => {
    await handler(makeReq() as never, makeRes() as never);

    expect(mockRecordVoiceActivity).toHaveBeenCalledWith('session-1', expect.any(Date), expect.any(Date));
  });

  it('marks only the hold its token names', async () => {
    const holdStartedAt = recentHold();
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
      voiceHoldStartedAt: holdStartedAt,
    });

    await handler(makeReq() as never, makeRes() as never);

    expect(mockRecordVoiceActivity).toHaveBeenCalledWith('session-1', expect.any(Date), new Date(holdStartedAt));
  });

  it('records nothing for a turn whose token does not verify', async () => {
    mockVerifyVoiceSessionToken.mockImplementation(() => {
      throw new Error('bad token');
    });
    const res = { ...makeRes(), status: () => ({ json: () => undefined }) };

    await handler(makeReq() as never, res as never);

    expect(mockRecordVoiceActivity).not.toHaveBeenCalled();
  });

  it('refuses a turn with 402 and no LLM call once the hold its token names is settled', async () => {
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
      voiceHoldStartedAt: recentHold(),
    });
    // POST /end claimed the hold, so the activity write matches nothing.
    mockRecordVoiceActivity.mockResolvedValue(false);
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { ...makeRes(), status };

    await handler(makeReq() as never, res as never);

    expect(status).toHaveBeenCalledWith(402);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  function expect402(status: ReturnType<typeof vi.fn>) {
    expect(status).toHaveBeenCalledWith(402);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  }

  it('refuses a legacy token that names no hold', async () => {
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
    });
    const status = vi.fn(() => ({ json: vi.fn() }));

    await handler(makeReq() as never, { ...makeRes(), status } as never);

    expect402(status);
  });

  it('refuses a turn when recording the activity fails, rather than serving it unbilled', async () => {
    mockRecordVoiceActivity.mockRejectedValue(new Error('db blip'));
    const status = vi.fn(() => ({ json: vi.fn() }));

    await handler(makeReq() as never, { ...makeRes(), status } as never);

    expect402(status);
  });

  it("refuses a turn past the hold's window even while the hold is still open", async () => {
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: '',
      reasoningModelId: 'test-model',
      voiceHoldStartedAt: new Date(Date.now() - (VOICE_SESSION_TOKEN_TTL_SECONDS + 1) * 1000).toISOString(),
    });
    const status = vi.fn(() => ({ json: vi.fn() }));

    await handler(makeReq() as never, { ...makeRes(), status } as never);

    expect402(status);
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - settled budget error', () => {
  beforeEach(primeSuccessfulTurn);

  it('speaks the settled reply before closing, rather than going silent', async () => {
    processState.terminalError = new Error('budget');
    mockInvoke.mockResolvedValue({ id: 'quest-1', replies: ['Out of room.'], reply: 'Out of room.' });

    await handler(makeReq() as never, makeRes() as never);

    expect(mockSseChunk).toHaveBeenCalledWith(expect.objectContaining({ contentDelta: 'Out of room.' }));
  });
});

describe('POST /api/voice/v2/llm-proxy/chat/completions - pipeline failure logging', () => {
  beforeEach(primeSuccessfulTurn);

  it('logs the error with flat name, message and cause strings so an alert does not print [object Object]', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    mockInvoke.mockRejectedValue(new TypeError('fetch failed', { cause }));
    const req = makeReq();

    await handler(req as never, makeRes() as never);

    expect(req.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorName: 'TypeError',
        errorMessage: 'fetch failed',
        errorCause: 'ECONNRESET: read ECONNRESET',
      }),
      '[voice-v2/llm-proxy] full pipeline failed'
    );
  });
});
