import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';
import { ReplSession } from './ReplSession';
import { buildBackendSubAgentQuery } from './backendSubAgent';

/**
 * Mock ICompletionBackend that records the call and feeds a canned
 * response into the streaming callback in one shot. The real backend
 * would chunk and call the callback multiple times; we collapse to a
 * single chunk for test simplicity.
 */
function fakeBackend(opts: {
  response: string;
  inputTokens?: number;
  outputTokens?: number;
  usdCost?: number;
}): ICompletionBackend {
  const calls: Array<{ model: string; messages: IMessage[]; options: Partial<ICompletionOptions> }> = [];
  const backend = {
    currentModel: 'mock-haiku',
    calls,
    complete: vi.fn(
      async (
        model: string,
        messages: IMessage[],
        options: Partial<ICompletionOptions>,
        callback: (texts: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        calls.push({ model, messages, options });
        const info: CompletionInfo = {
          inputTokens: opts.inputTokens ?? 100,
          outputTokens: opts.outputTokens ?? 30,
          usdCost: opts.usdCost,
        };
        await callback([opts.response], info);
      }
    ),
    pushToolCallAndResult: vi.fn(),
    embed: vi.fn(),
  } as unknown as ICompletionBackend & {
    calls: Array<{ model: string; messages: IMessage[]; options: Partial<ICompletionOptions> }>;
  };
  return backend;
}

describe('buildBackendSubAgentQuery', () => {
  let session: ReplSession;

  beforeEach(() => {
    session = new ReplSession({ sessionId: 'sub-agent-test' });
  });

  it('calls the backend with the provided model + prompt and returns the streamed text', async () => {
    const backend = fakeBackend({ response: 'hello from haiku' });
    const sub = buildBackendSubAgentQuery({
      llm: backend,
      modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      session,
    });

    const out = await sub({ prompt: 'classify this thing' });
    expect(out).toBe('hello from haiku');

    const calls = (backend as unknown as { calls: Array<{ model: string; messages: IMessage[] }> }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'classify this thing' }]);
  });

  it('records token + cost usage on the session budget (uses backend usdCost when set)', async () => {
    const backend = fakeBackend({ response: 'ok', inputTokens: 200, outputTokens: 50, usdCost: 0.0042 });
    const sub = buildBackendSubAgentQuery({
      llm: backend,
      modelId: 'mock-haiku',
      session,
    });
    await sub({ prompt: 'x' });

    const u = session.getUsage();
    expect(u.subLlmCalls).toBe(1);
    expect(u.promptTokens).toBe(200);
    expect(u.completionTokens).toBe(50);
    expect(u.totalCostUsd).toBe(0.0042);
  });

  it('falls back to a Haiku-rate cost estimate when backend does not provide usdCost', async () => {
    const backend = fakeBackend({ response: 'ok', inputTokens: 1_000_000, outputTokens: 500_000 });
    const sub = buildBackendSubAgentQuery({
      llm: backend,
      modelId: 'mock-haiku',
      session,
    });
    await sub({ prompt: 'x' });

    // 1M input * $0.8/M + 500K output * $4/M = $0.80 + $2.00 = $2.80
    expect(session.getUsage().totalCostUsd).toBeCloseTo(2.8, 5);
  });

  it('rejects empty prompts with a clear message', async () => {
    const backend = fakeBackend({ response: '' });
    const sub = buildBackendSubAgentQuery({
      llm: backend,
      modelId: 'mock-haiku',
      session,
    });
    await expect(sub({ prompt: '' })).rejects.toThrow('non-empty string');
    await expect(sub({})).rejects.toThrow();
  });

  it('respects max_tokens override but caps to ceiling', async () => {
    const backend = fakeBackend({ response: 'ok' });
    const sub = buildBackendSubAgentQuery({
      llm: backend,
      modelId: 'mock-haiku',
      session,
      maxTokensCeiling: 1000,
    });

    await sub({ prompt: 'x', max_tokens: 999 });
    let calls = (backend as unknown as { calls: Array<{ options: Partial<ICompletionOptions> }> }).calls;
    expect(calls[0].options.maxTokens).toBe(999);

    await sub({ prompt: 'y', max_tokens: 5000 });
    calls = (backend as unknown as { calls: Array<{ options: Partial<ICompletionOptions> }> }).calls;
    expect(calls[1].options.maxTokens).toBe(1000); // capped
  });
});
