import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';

// Real @bike4mind/common (pure SSE helpers + the published stream-event schema, which
// these tests parse frames against). Only the seams below are mocked.
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    updateMetadata = vi.fn();
  },
}));

const mockExecuteCompletion = vi.hoisted(() => vi.fn());
// Stand-in for the real class (the whole services module is mocked): same `.code`
// carrier the services-side resolver reads.
const MockInsufficientCreditsError = vi.hoisted(
  () =>
    class MockInsufficientCreditsError extends Error {
      constructor(
        message: string,
        readonly code?: string
      ) {
        super(message);
      }
    }
);
vi.mock('@bike4mind/services/cliCompletions', () => ({
  executeCompletion: mockExecuteCompletion,
}));

vi.mock('@bike4mind/services/llm', async () => {
  // Mirror the real resolveQuestErrorCode against the stand-in class, delegating
  // tagged 422s to the REAL getQuestErrorCode so classification stays end-to-end.
  const { getQuestErrorCode } = await vi.importActual<typeof import('@bike4mind/common')>('@bike4mind/common');
  return {
    InsufficientCreditsError: MockInsufficientCreditsError,
    resolveQuestErrorCode: (error: unknown) =>
      error instanceof MockInsufficientCreditsError ? error.code : getQuestErrorCode(error),
  };
});

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  mongoose: { connection: { readyState: 1 } },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  usageEventRepository: { record: vi.fn() },
  organizationRepository: {},
  userApiKeyRepository: { findById: vi.fn().mockResolvedValue({ id: 'key-1', name: 'cli' }) },
}));

const mockResolveContractAuth = vi.hoisted(() => vi.fn());
vi.mock('@server/cli/resolveContractAuth', () => ({ resolveContractAuth: mockResolveContractAuth }));

vi.mock('@server/cli/auth', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(undefined),
  checkApiKeyRateLimitOrThrow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/logCompletionAnalytics', () => ({
  logCompletionAnalytics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%', STAGE: 'test' } }));

import { registerExternalRoutes } from './sseRoute';
import { CompletionStreamEventSchema, spendCapExceededError } from '@bike4mind/common';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  registerExternalRoutes(app, () => {});
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(() => server?.close());

beforeEach(() => {
  mockResolveContractAuth.mockResolvedValue({
    method: 'apiKey',
    userId: 'user-1',
    apiKeyInfo: { keyId: 'key-1', userId: 'user-1' },
  });
  mockExecuteCompletion.mockImplementation(async (params: { onChunk: (t: string[], i?: unknown) => Promise<void> }) => {
    await params.onChunk(['', 'hello'], { outputTokens: 5 });
  });
});

afterEach(() => vi.clearAllMocks());

const COMPLETION = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };

function post(body: unknown = COMPLETION) {
  return fetch(`${baseUrl}/api/ai/v1/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'b4m_live_test' },
    body: JSON.stringify(body),
  });
}

/** Every JSON `data:` frame in an SSE body, `[DONE]` excluded. */
function frames(body: string): Record<string, unknown>[] {
  return body
    .split('\n\n')
    .map(f => f.trim())
    .filter(f => f.startsWith('data: ') && f.slice(6) !== '[DONE]')
    .map(f => JSON.parse(f.slice(6)));
}

/**
 * The single terminal error frame, asserted to conform to the published contract
 * schema (CompletionStreamEventSchema) rather than merely to be JSON - that parse is
 * what makes an untyped classifier a test failure here and not just in the spec gate.
 */
function errorFrame(body: string) {
  const errors = frames(body).filter(f => f.type === 'error');
  expect(errors).toHaveLength(1);
  return CompletionStreamEventSchema.parse(errors[0]) as { type: 'error'; message: string; code?: string };
}

describe('POST /api/ai/v1/completions', () => {
  it('streams content and terminates with [DONE]', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('hello');
    expect(text).toContain('[DONE]');
    expect(frames(text).some(f => f.type === 'error')).toBe(false);
  });

  // The reservation refuses before the provider is called, so nothing has streamed
  // yet - but headers were flushed at request start, so this can only be reported
  // in-band. There is no pre-stream 422 to fall back to on this endpoint.
  it('classifies exhaustion caught by the pre-token reservation on the error frame', async () => {
    mockExecuteCompletion.mockRejectedValue(new MockInsufficientCreditsError('out of credits', 'insufficient_credits'));
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(errorFrame(text).code).toBe('insufficient_credits');
    // Never prose in a content event: a caller reading only `text` would render the
    // billing failure as part of the assistant's reply.
    expect(frames(text).some(f => f.type === 'content' && String(f.text).includes('credits'))).toBe(false);
  });

  // The case the classifier exists for: tokens already streamed, so neither a status
  // code nor a pre-flight check can carry the signal.
  it('terminates a partially streamed completion with insufficient_credits', async () => {
    mockExecuteCompletion.mockImplementation(
      async (params: { onChunk: (t: string[], i?: unknown) => Promise<void> }) => {
        await params.onChunk(['', 'partial answer'], { outputTokens: 3 });
        throw new MockInsufficientCreditsError('ran out mid-generation', 'insufficient_credits');
      }
    );
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('partial answer');
    expect(errorFrame(text).code).toBe('insufficient_credits');
    // Terminal: the stream must not also claim a clean finish.
    expect(text).not.toContain('[DONE]');
  });

  // Distinct remediation (raise the key's cap, not buy credits), so it must not
  // collapse onto insufficient_credits. Wiring test: today the completions path has
  // no in-loop cap check, so this pins that a tagged 422 arriving here stays itself.
  it('keeps spend_cap_exceeded distinct on the error frame', async () => {
    mockExecuteCompletion.mockRejectedValue(spendCapExceededError('key hit its cap'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(errorFrame(await res.text()).code).toBe('spend_cap_exceeded');
  });

  it('omits the classifier entirely for an unclassified failure', async () => {
    mockExecuteCompletion.mockRejectedValue(new Error('model backend blew up'));
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(errorFrame(text).code).toBeUndefined();
    expect(text).not.toContain('"code"');
  });

  it('reports an unclassified auth failure in-band with no classifier', async () => {
    mockResolveContractAuth.mockRejectedValue(new Error('bad key'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(errorFrame(await res.text()).code).toBeUndefined();
    expect(mockExecuteCompletion).not.toHaveBeenCalled();
  });
});
