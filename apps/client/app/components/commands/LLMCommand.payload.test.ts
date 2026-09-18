import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guards the CLIENT half of the auto-offer lever. The server side of `skipAutoOffers` has been
 * live and tested since #2546, but no SPA call site ever set it - so a server-only test passed
 * for months while the feature was unreachable. These assertions fail if the field stops
 * reaching the request body, or starts riding `params` instead of the top level.
 */

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));

// The optimistic-cache wrappers just bracket the network call; run the callback straight through
// so the payload assertion sees the real post.
vi.mock('@client/app/utils/llm', () => ({
  createOptimisticQuest: (_qc: unknown, _sid: unknown, _prompt: unknown, cb: () => unknown) => cb(),
  updateOptimisticQuest: (_qc: unknown, _q: unknown, _s: unknown, _d: unknown, cb: () => unknown) => cb(),
  createOptimisticSessionId: () => 'tmp-session-1',
}));

import { handleLLMCommand } from './LLMCommand';

type HandlerArgs = Parameters<typeof handleLLMCommand>[0];

const baseArgs = (): HandlerArgs =>
  ({
    params: 'hello world',
    currentSession: { id: 'session-1' },
    model: 'claude-sonnet-5',
    workBenchFiles: [],
    promptFileIds: [],
    queryClient: {},
    tools: [],
    userId: 'user-1',
    modelConfigurations: [],
    sendJsonMessage: vi.fn(),
  }) as unknown as HandlerArgs;

const llmRequestBody = () => {
  const call = post.mock.calls.find(c => c[0] === '/api/ai/llm');
  if (!call) throw new Error('no POST to /api/ai/llm was made');
  return call[1] as Record<string, unknown> & { params?: Record<string, unknown> };
};

describe('handleLLMCommand - skipAutoOffers on the wire', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { quest: { id: 'quest-1' }, session: { id: 'session-1' } } });
  });

  it('sends skipAutoOffers: true at the top level when the toggle is on', async () => {
    await handleLLMCommand({ ...baseArgs(), skipAutoOffers: true });

    expect(llmRequestBody().skipAutoOffers).toBe(true);
  });

  it('omits skipAutoOffers entirely when the toggle is off', async () => {
    await handleLLMCommand({ ...baseArgs(), skipAutoOffers: false });

    expect(llmRequestBody()).not.toHaveProperty('skipAutoOffers');
  });

  it('omits skipAutoOffers when the caller never sets it', async () => {
    await handleLLMCommand(baseArgs());

    expect(llmRequestBody()).not.toHaveProperty('skipAutoOffers');
  });

  // `params` is built by spreading the leftover args, so a field missing from the omit list
  // silently rides along inside it as well - which the server never reads.
  it('does not also nest skipAutoOffers inside params', async () => {
    await handleLLMCommand({ ...baseArgs(), skipAutoOffers: true });

    expect(llmRequestBody().params).not.toHaveProperty('skipAutoOffers');
  });
});
