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
} = vi.hoisted(() => ({
  mockVerifyVoiceSessionToken: vi.fn(),
  mockFindDuplicateQuests: vi.fn(),
  mockUserFindById: vi.fn(),
  mockGetSettingsMap: vi.fn(),
  mockInvoke: vi.fn(),
  mockProcess: vi.fn(),
}));

// Bypass baseApi's whole middleware chain (connectDB, passport, api-key auth) - this
// route only cares about the body its own handler builds, and `.post()` here hands
// back the raw handler so tests can call it directly. Mirrors
// pages/api/data-lakes/__tests__/semantic-search.test.ts.
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

vi.mock('@server/utils/chatCompletionDefaults', () => ({
  getDefaultChatCompletionOptions: () => ({}),
  getSharedTokenizer: () => ({}),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
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
    prefetchedSession = undefined;
    prefetchedOrganization = undefined;
    invoke = (...args: unknown[]) => mockInvoke(...args);
  },
  ChatCompletionProcess: class {
    process = (...args: unknown[]) => mockProcess(...args);
  },
}));

vi.mock('@bike4mind/voice', () => ({
  buildClientToolPassthrough: () => ({}),
  currentTurnUserMessage: () => 'hello there',
  diffAccumulated: () => '',
  extractSystemPrompt: () => '',
  emitInitialBuffer: () => {},
  openAiSseChunk: () => 'chunk',
  openAiSseDone: () => 'done',
  stripSpokenThinking: (text: string) => text,
  writeStaticCompletion: () => {},
}));

import handler from '../completions';

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

describe('POST /api/voice/v2/llm-proxy/chat/completions - deniedTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyVoiceSessionToken.mockReturnValue({
      userId: 'user-1',
      sessionId: 'session-1',
      organizationId: undefined,
      reasoningModelId: 'test-model',
    });
    mockFindDuplicateQuests.mockResolvedValue([]);
    mockUserFindById.mockResolvedValue({ id: 'user-1' });
    mockGetSettingsMap.mockResolvedValue({});
    mockInvoke.mockResolvedValue({ id: 'quest-1', replies: [], reply: '' });
    mockProcess.mockResolvedValue(undefined);
  });

  it('denies the data-lake tools on both the invoke and process bodies', async () => {
    const req = makeReq();
    const res = makeRes();

    await handler(req as never, res as never);

    const expected = ['list_my_data_lakes', 'create_data_lake', 'save_content_to_data_lake'];
    expect((mockInvoke.mock.calls[0][0] as { body: { deniedTools?: string[] } }).body.deniedTools).toEqual(expected);
    expect((mockProcess.mock.calls[0][0] as { body: { deniedTools?: string[] } }).body.deniedTools).toEqual(expected);
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
