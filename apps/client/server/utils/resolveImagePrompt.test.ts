import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IChatHistoryItemDocument } from '@bike4mind/common';

// Mocks

const { mockLogger, mockLlmComplete, mockOperationsModelService, mockGetEffectiveApiKeyByBackend } = vi.hoisted(() => ({
  mockLogger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  mockLlmComplete: vi.fn(),
  mockOperationsModelService: {
    getOperationsModel: vi.fn(),
  },
  mockGetEffectiveApiKeyByBackend: vi.fn(),
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return { ...actual };
});

// getLlmByModel moved to @bike4mind/llm-adapters - mock it here.
vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getLlmByModel: vi.fn(() => ({ complete: mockLlmComplete })) };
});

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: mockOperationsModelService,
  getEffectiveApiKeyByBackend: mockGetEffectiveApiKeyByBackend,
}));

import {
  resolveImagePrompt,
  sessionHasHistory,
  buildHistoryTranscript,
  tryParseJsonObject,
} from './resolveImagePrompt';

// Fixtures

const makeImageMessage = (id: string, prompt: string): IChatHistoryItemDocument =>
  ({
    id,
    type: 'message',
    prompt,
    images: ['s3://bucket/img.png'],
    timestamp: new Date(),
  }) as unknown as IChatHistoryItemDocument;

const makeTextMessage = (id: string, prompt: string, reply: string): IChatHistoryItemDocument =>
  ({
    id,
    type: 'message',
    prompt,
    reply,
    images: [],
    timestamp: new Date(),
  }) as unknown as IChatHistoryItemDocument;

const makeRepliesMessage = (id: string, prompt: string, replies: unknown[]): IChatHistoryItemDocument =>
  ({
    id,
    type: 'message',
    prompt,
    reply: undefined,
    replies,
    images: [],
    timestamp: new Date(),
  }) as unknown as IChatHistoryItemDocument;

const makeErrorMessage = (id: string, prompt: string): IChatHistoryItemDocument =>
  ({
    id,
    type: 'error',
    prompt,
    images: ['s3://bucket/img.png'],
    timestamp: new Date(),
  }) as unknown as IChatHistoryItemDocument;

const setupOperationsModel = () => {
  mockOperationsModelService.getOperationsModel.mockResolvedValue({
    modelInfo: { id: 'gpt-4o-mini', backend: 'openai' },
  });
  mockGetEffectiveApiKeyByBackend.mockResolvedValue('sk-test');
};

// Pure helpers

describe('sessionHasHistory', () => {
  it('returns true when there is at least one prior turn (image)', () => {
    expect(sessionHasHistory([makeImageMessage('a', 'cat')])).toBe(true);
  });

  it('returns true when there is at least one prior turn (text)', () => {
    expect(sessionHasHistory([makeTextMessage('a', 'hi', 'hello')])).toBe(true);
  });

  it('returns true even for error turns (history exists)', () => {
    expect(sessionHasHistory([makeErrorMessage('a', 'bad')])).toBe(true);
  });

  it('returns false for an empty session — only literal first message of session triggers the fast path', () => {
    expect(sessionHasHistory([])).toBe(false);
  });
});

describe('buildHistoryTranscript', () => {
  it('orders oldest first and tags image-gen turns', () => {
    const recent = [makeImageMessage('newest', 'second prompt'), makeImageMessage('older', 'first prompt')];
    const transcript = buildHistoryTranscript(recent);
    const lines = transcript.split('\n');
    expect(lines[0]).toContain('[1]');
    expect(lines[0]).toContain('first prompt');
    expect(lines[0]).toContain('image generated');
    expect(lines[1]).toContain('[2]');
    expect(lines[1]).toContain('second prompt');
  });

  it('includes assistant reply text for text turns (truncated)', () => {
    const longReply = 'A'.repeat(500);
    const transcript = buildHistoryTranscript([makeTextMessage('a', 'tell me about coffee', longReply)]);
    expect(transcript).toContain('"tell me about coffee"');
    expect(transcript).toContain('assistant: "');
    // Reply truncated with ellipsis
    expect(transcript).toMatch(/A{200,}…"/);
    expect(transcript.length).toBeLessThan(500);
  });

  it('joins replies array when reply field is empty', () => {
    const recent = [makeRepliesMessage('a', 'q', [{ content: 'part one ' }, { content: 'part two' }])];
    expect(buildHistoryTranscript(recent)).toContain('assistant: "part one part two"');
  });

  it('marks error turns as "error"', () => {
    expect(buildHistoryTranscript([makeErrorMessage('e', 'oops')])).toContain('"oops" → error');
  });

  it('falls back to "reply" label for text turns missing both reply and replies', () => {
    const recent = [makeRepliesMessage('a', 'q', [])];
    expect(buildHistoryTranscript(recent)).toMatch(/"q" → reply$/);
  });

  it('collapses whitespace in prompts and replies', () => {
    const messy = makeTextMessage('m', 'line one\n\n  line  two', 'reply\n\n with   whitespace');
    const transcript = buildHistoryTranscript([messy]);
    expect(transcript).toContain('"line one line two"');
    expect(transcript).toContain('"reply with whitespace"');
  });
});

describe('tryParseJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(tryParseJsonObject('{"intent":"fresh","rewrittenPrompt":"x"}')).toEqual({
      intent: 'fresh',
      rewrittenPrompt: 'x',
    });
  });

  it('parses JSON wrapped in ```json fences', () => {
    expect(tryParseJsonObject('```json\n{"intent":"continuation","rewrittenPrompt":"y"}\n```')).toEqual({
      intent: 'continuation',
      rewrittenPrompt: 'y',
    });
  });

  it('parses JSON wrapped in plain ``` fences', () => {
    expect(tryParseJsonObject('```\n{"intent":"fresh","rewrittenPrompt":"z"}\n```')).toEqual({
      intent: 'fresh',
      rewrittenPrompt: 'z',
    });
  });

  it('extracts JSON from surrounding prose by locating outermost braces', () => {
    expect(tryParseJsonObject('Here you go: {"intent":"fresh","rewrittenPrompt":"x"} done.')).toEqual({
      intent: 'fresh',
      rewrittenPrompt: 'x',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseJsonObject('{not json}')).toBeNull();
  });

  it('returns null when there is no object at all', () => {
    expect(tryParseJsonObject('just a sentence with no json')).toBeNull();
  });
});

// resolveImagePrompt

describe('resolveImagePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips the LLM call entirely when the session has no prior history (literal first message)', async () => {
    const result = await resolveImagePrompt({
      originalPrompt: 'a sunset over the sea',
      recentMessages: [],
      logger: mockLogger as never,
    });
    expect(result).toEqual({ rewrittenPrompt: 'a sunset over the sea', intent: 'fresh' });
    expect(mockLlmComplete).not.toHaveBeenCalled();
    expect(mockOperationsModelService.getOperationsModel).not.toHaveBeenCalled();
  });

  it('runs the resolver when prior history is text-only (text-grounded image generation)', async () => {
    setupOperationsModel();
    mockLlmComplete.mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb([
        '{"intent":"continuation","rewrittenPrompt":"A minimalist wordmark logo for Verdant sustainable coffee brand, deep navy on cream."}',
      ]);
    });

    const result = await resolveImagePrompt({
      originalPrompt: 'great, now generate the logo',
      recentMessages: [
        makeTextMessage(
          'm1',
          "what's a good direction for a sustainable coffee brand called Verdant?",
          'A minimalist wordmark in a humanist serif works well…'
        ),
        makeTextMessage(
          'm2',
          "let's lean humanist serif with deep navy ink",
          'Good — generous letter-spacing will reinforce the artisanal feel.'
        ),
      ],
      logger: mockLogger as never,
    });

    expect(result.intent).toBe('continuation');
    expect(result.rewrittenPrompt).toContain('Verdant');
    expect(mockLlmComplete).toHaveBeenCalledTimes(1);
  });

  it('passes the session summary into the resolver prompt when provided', async () => {
    setupOperationsModel();
    let capturedUserMessage = '';
    mockLlmComplete.mockImplementation(async (_model, msgs, _opts, cb) => {
      capturedUserMessage =
        (msgs as Array<{ role: string; content: string }>).find(m => m.role === 'user')?.content ?? '';
      await cb(['{"intent":"continuation","rewrittenPrompt":"A logo."}']);
    });

    await resolveImagePrompt({
      originalPrompt: 'now make the logo',
      recentMessages: [makeTextMessage('m1', 'q', 'a')],
      sessionSummary: 'User is brainstorming a sustainable coffee brand named Verdant.',
      logger: mockLogger as never,
    });

    expect(capturedUserMessage).toContain('Session summary:');
    expect(capturedUserMessage).toContain('Verdant');
  });

  it('omits the summary section when no summary is provided', async () => {
    setupOperationsModel();
    let capturedUserMessage = '';
    mockLlmComplete.mockImplementation(async (_model, msgs, _opts, cb) => {
      capturedUserMessage =
        (msgs as Array<{ role: string; content: string }>).find(m => m.role === 'user')?.content ?? '';
      await cb(['{"intent":"continuation","rewrittenPrompt":"x"}']);
    });

    await resolveImagePrompt({
      originalPrompt: 'now make the logo',
      recentMessages: [makeTextMessage('m1', 'q', 'a')],
      sessionSummary: null,
      logger: mockLogger as never,
    });

    expect(capturedUserMessage).not.toContain('Session summary:');
  });

  it('treats empty/whitespace-only summaries as absent', async () => {
    setupOperationsModel();
    let capturedUserMessage = '';
    mockLlmComplete.mockImplementation(async (_model, msgs, _opts, cb) => {
      capturedUserMessage =
        (msgs as Array<{ role: string; content: string }>).find(m => m.role === 'user')?.content ?? '';
      await cb(['{"intent":"fresh","rewrittenPrompt":"x"}']);
    });

    await resolveImagePrompt({
      originalPrompt: 'p',
      recentMessages: [makeTextMessage('m1', 'q', 'a')],
      sessionSummary: '   \n  ',
      logger: mockLogger as never,
    });

    expect(capturedUserMessage).not.toContain('Session summary:');
  });

  it('returns parsed structured output for visual-continuation follow-ups', async () => {
    setupOperationsModel();
    mockLlmComplete.mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb(['{"intent":"continuation","rewrittenPrompt":"A modern signage variant without lighting."}']);
    });

    const result = await resolveImagePrompt({
      originalPrompt: 'different variant, no lighting',
      recentMessages: [makeImageMessage('m1', 'modern signage')],
      logger: mockLogger as never,
    });

    expect(result).toEqual({
      intent: 'continuation',
      rewrittenPrompt: 'A modern signage variant without lighting.',
    });
  });

  it('falls back to original prompt + continuation intent when the resolver returns malformed JSON', async () => {
    setupOperationsModel();
    mockLlmComplete.mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb(['this is not JSON at all']);
    });

    const result = await resolveImagePrompt({
      originalPrompt: 'different variant',
      recentMessages: [makeImageMessage('m1', 'signage')],
      logger: mockLogger as never,
    });

    expect(result).toEqual({ rewrittenPrompt: 'different variant', intent: 'continuation' });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('falls back when the resolver returns JSON with the wrong shape (Zod validation failure)', async () => {
    setupOperationsModel();
    mockLlmComplete.mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb(['{"intent":"maybe","rewrittenPrompt":""}']);
    });

    const result = await resolveImagePrompt({
      originalPrompt: 'different variant',
      recentMessages: [makeImageMessage('m1', 'signage')],
      logger: mockLogger as never,
    });

    expect(result).toEqual({ rewrittenPrompt: 'different variant', intent: 'continuation' });
  });

  it('falls back when the LLM call throws', async () => {
    setupOperationsModel();
    mockLlmComplete.mockRejectedValue(new Error('network down'));

    const result = await resolveImagePrompt({
      originalPrompt: 'different variant',
      recentMessages: [makeImageMessage('m1', 'signage')],
      logger: mockLogger as never,
    });

    expect(result).toEqual({ rewrittenPrompt: 'different variant', intent: 'continuation' });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('falls back when the LLM call exceeds the 5s timeout (prevents Lambda burn during degradation)', async () => {
    vi.useFakeTimers();
    setupOperationsModel();
    // LLM call that never resolves within the timeout window
    mockLlmComplete.mockImplementation(
      () => new Promise(() => undefined) // hangs forever
    );

    const resultPromise = resolveImagePrompt({
      originalPrompt: 'different variant',
      recentMessages: [makeImageMessage('m1', 'signage')],
      logger: mockLogger as never,
    });

    // Fast-forward past the 5s timeout
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result).toEqual({ rewrittenPrompt: 'different variant', intent: 'continuation' });
    expect(mockLogger.error).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('classifies a clearly fresh prompt as "fresh" even within a session that has prior context', async () => {
    setupOperationsModel();
    mockLlmComplete.mockImplementation(async (_model, _msgs, _opts, cb) => {
      await cb(['{"intent":"fresh","rewrittenPrompt":"A logo for Acme Corp."}']);
    });

    const result = await resolveImagePrompt({
      originalPrompt: 'now generate a logo for Acme Corp',
      recentMessages: [makeImageMessage('m1', 'sunset beach')],
      logger: mockLogger as never,
    });

    expect(result.intent).toBe('fresh');
    expect(result.rewrittenPrompt).toContain('Acme Corp');
  });
});
