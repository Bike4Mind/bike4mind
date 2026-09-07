import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplSession, BudgetExceededError } from '@bike4mind/agents';
import { buildDataLakeTools } from './tools';

/**
 * subAgentQuery is the only tool in the REPL that spends money directly, and
 * both of its arguments that matter - which model, and how many calls - come
 * from LLM-authored code. These cover the two ways that used to escape the
 * per-request cost cap: an unpriced model billed at Haiku's rate, and a
 * concurrent fan-out that outran a counter only incremented on the way back.
 */

const createSpy = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createSpy };
  },
}));

const HAIKU = 'claude-haiku-4-5-20251001';

function toolsFor(session: ReplSession) {
  return buildDataLakeTools({
    baseUrl: 'http://localhost:3000',
    authHeaders: { 'x-api-key': 'k' },
    anthropicApiKey: 'a',
    session,
  });
}

describe('subAgentQuery model allowlist', () => {
  beforeEach(() => {
    createSpy.mockReset();
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 30 },
    });
  });

  it('dispatches the default and the "haiku" alias to the priced Haiku model', async () => {
    const session = new ReplSession({ sessionId: 'allow-default', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await subAgentQuery({ prompt: 'hi' });
    await subAgentQuery({ prompt: 'hi', model: 'haiku' });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[0][0].model).toBe(HAIKU);
    expect(createSpy.mock.calls[1][0].model).toBe(HAIKU);
  });

  it('refuses an unpriced model instead of billing it at Haiku rates', async () => {
    const session = new ReplSession({ sessionId: 'allow-opus', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await expect(subAgentQuery({ prompt: 'hi', model: 'claude-opus-4-1-20250805' })).rejects.toThrow(/not available/i);
    // The point of refusing is that no spend happens at all.
    expect(createSpy).not.toHaveBeenCalled();
    expect(session.getUsage().subLlmCalls).toBe(0);
  });

  it('names the allowed models so the agent can correct itself', async () => {
    const session = new ReplSession({ sessionId: 'allow-msg', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await expect(subAgentQuery({ prompt: 'hi', model: 'gpt-4o' })).rejects.toThrow(new RegExp(HAIKU));
  });

  it('charges the model actually invoked at its own rate', async () => {
    const session = new ReplSession({ sessionId: 'allow-cost', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await subAgentQuery({ prompt: 'hi' });

    // 100 input at $0.8/M + 30 output at $4/M.
    expect(session.getUsage().totalCostUsd).toBeCloseTo(100 * 0.8e-6 + 30 * 4e-6, 12);
  });
});

describe('subAgentQuery budget reservation under fan-out', () => {
  beforeEach(() => {
    createSpy.mockReset();
  });

  it('sends no more requests than maxSubLlmCalls when every call is in flight at once', async () => {
    // Every dispatch parks until we release it, so all of them are
    // simultaneously in flight - the shape that defeated a counter only
    // incremented after the provider replied.
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      releaseAll = resolve;
    });
    createSpy.mockImplementation(async () => {
      await gate;
      return { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } };
    });

    const session = new ReplSession({
      sessionId: 'fanout',
      executor: 'in-process-unsafe',
      budget: { maxSubLlmCalls: 3, maxCostUsd: 1000 },
    });
    const { subAgentQuery } = toolsFor(session);

    const settled = Promise.allSettled(Array.from({ length: 12 }, (_, i) => subAgentQuery({ prompt: `q${i}` })));
    // The refusals are synchronous, so the over-cap calls have already been
    // turned away before anything is allowed to return.
    await Promise.resolve();
    expect(createSpy).toHaveBeenCalledTimes(3);

    releaseAll();
    const results = await settled;
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.every(r => r.status === 'fulfilled' || r.reason instanceof BudgetExceededError)).toBe(true);
    expect(session.getUsage().subLlmCalls).toBe(3);
  });

  it('gives the slot back when the provider call itself fails', async () => {
    createSpy.mockRejectedValueOnce(new Error('provider exploded')).mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const session = new ReplSession({
      sessionId: 'fanout-release',
      executor: 'in-process-unsafe',
      budget: { maxSubLlmCalls: 1, maxCostUsd: 1000 },
    });
    const { subAgentQuery } = toolsFor(session);

    await expect(subAgentQuery({ prompt: 'boom' })).rejects.toThrow(/provider exploded/);
    expect(session.getUsage().subLlmCalls).toBe(0);
    // The single authorized call is still available.
    await expect(subAgentQuery({ prompt: 'retry' })).resolves.toBe('ok');
  });
});

describe('subAgentQuery reservation cannot leak', () => {
  beforeEach(() => {
    createSpy.mockReset();
  });

  it('does not strand a claim when the provider returns a malformed usage payload', async () => {
    // The reservation is taken before dispatch and settled from `msg.usage`.
    // A response without it throws between the two, which used to leave the
    // claim counted forever and shrink the budget for the rest of the session.
    createSpy.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] }).mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const session = new ReplSession({
      sessionId: 'leak',
      executor: 'in-process-unsafe',
      budget: { maxSubLlmCalls: 1, maxCostUsd: 1000 },
    });
    const { subAgentQuery } = toolsFor(session);

    await expect(subAgentQuery({ prompt: 'malformed' })).rejects.toThrow();
    expect(session.getUsage().subLlmCalls).toBe(0);
    // The one authorized call is still there to be spent.
    await expect(subAgentQuery({ prompt: 'retry' })).resolves.toBe('ok');
    expect(session.getUsage().subLlmCalls).toBe(1);
  });
});
