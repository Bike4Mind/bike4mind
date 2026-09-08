import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReplSession, BudgetExceededError } from '@bike4mind/agents';
import { buildDataLakeTools } from './tools';
import { SUB_LLM_HTTP_TIMEOUT_MS } from './timeouts';

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

    // 100 input at $1/M + 30 output at $5/M - Haiku 4.5 list price. The table
    // previously carried Haiku 3.5's $0.80 / $4.00, under-counting by 20%.
    expect(session.getUsage().totalCostUsd).toBeCloseTo(100 * 1e-6 + 30 * 5e-6, 12);
  });

  // The allowlist and the price table are the same lookup on purpose, so the
  // lookup itself has to be exact. A plain object resolves inherited keys, so
  // `model: 'constructor'` returned Object's constructor, passed the
  // truthiness check, and reached the provider priced at whatever that
  // function coerced to.
  it.each([['constructor'], ['toString'], ['valueOf'], ['__proto__'], ['hasOwnProperty']])(
    'refuses the prototype-chain key %s',
    async model => {
      const session = new ReplSession({ sessionId: `proto-${model}`, executor: 'in-process-unsafe' });
      const { subAgentQuery } = toolsFor(session);

      await expect(subAgentQuery({ prompt: 'hi', model })).rejects.toThrow(/not available/i);
      expect(createSpy).not.toHaveBeenCalled();
      expect(session.getUsage().subLlmCalls).toBe(0);
    }
  );

  it('refuses a non-string model rather than coercing it', async () => {
    const session = new ReplSession({ sessionId: 'nonstring-model', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await expect(subAgentQuery({ prompt: 'hi', model: { toString: () => HAIKU } } as never)).rejects.toThrow(
      /not available/i
    );
    expect(createSpy).not.toHaveBeenCalled();
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

describe('subAgentQuery provider-call bounds', () => {
  beforeEach(() => {
    createSpy.mockReset();
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  /**
   * The abort signal is the only thing stopping this call from outliving its
   * tool-dispatch bound and billing for an answer nobody is waiting on, and
   * it lives in the SECOND argument to `messages.create` - the request
   * options, not the payload - so nothing about the payload assertions
   * elsewhere in this file would notice it disappearing.
   */
  it('bounds the provider call with an abort signal', async () => {
    const session = new ReplSession({ sessionId: 'signal', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await subAgentQuery({ prompt: 'hi' });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const options = createSpy.mock.calls[0][1];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  /**
   * The ceiling is half of one decision with `SUB_LLM_HTTP_TIMEOUT_MS`: a
   * request at the ceiling must be able to finish inside the deadline. The
   * literal is written out rather than imported, because importing the
   * constant would assert only that it equals itself - and it was an 8000
   * against a 15s bound that made every large request a billed abort.
   */
  it('clamps the output ceiling to what the deadline can deliver', async () => {
    const session = new ReplSession({ sessionId: 'ceiling', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await subAgentQuery({ prompt: 'hi', max_tokens: 8000 });

    expect(createSpy.mock.calls[0][0].max_tokens).toBe(2000);
  });

  it('still honours a caller asking for less than the ceiling', async () => {
    const session = new ReplSession({ sessionId: 'under', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    await subAgentQuery({ prompt: 'hi', max_tokens: 256 });

    expect(createSpy.mock.calls[0][0].max_tokens).toBe(256);
  });
});

describe('subAgentQuery abort accounting', () => {
  beforeEach(() => {
    createSpy.mockReset();
    // Hangs until the tool's OWN deadline aborts the signal it passed, which
    // is the only way to exercise the mid-generation case: the SDK's
    // `APIUserAbortError` never assigns `name`, so a hand-made error with an
    // abort-sounding name would test a classification the code does not do.
    createSpy.mockImplementation(
      (_payload: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
        })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run a call and let only its deadline elapse. */
  async function expireDeadline(call: Promise<unknown>): Promise<unknown> {
    const settled = call.then(
      v => v,
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(SUB_LLM_HTTP_TIMEOUT_MS + 1);
    return settled;
  }

  /**
   * An abort is the one failure that still costs money: the deadline fires
   * mid-generation, so the provider has already billed the tokens it
   * produced. `release()` books $0 and hands the slot back - which is how a
   * session walks past its own cap one timeout at a time. A failed DISPATCH
   * is the case that should still release, and the test above pins that.
   */
  it('books the estimate when its own deadline aborts a call mid-generation', async () => {
    vi.useFakeTimers();
    const session = new ReplSession({
      sessionId: 'abort-books',
      executor: 'in-process-unsafe',
      budget: { maxSubLlmCalls: 4, maxCostUsd: 1000 },
    });
    const { subAgentQuery } = toolsFor(session);

    const err = await expireDeadline(subAgentQuery({ prompt: 'hi' }));

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/aborted/i);
    const usage = session.getUsage();
    expect(usage.subLlmCalls).toBe(1);
    expect(usage.totalCostUsd).toBeGreaterThan(0);
  });

  it('counts aborted spend against the cost cap', async () => {
    vi.useFakeTimers();
    // One call's estimate is ~$0.0075 at the default 1500-token ceiling, so
    // this cap admits the first and has to refuse the second.
    const session = new ReplSession({
      sessionId: 'abort-cap',
      executor: 'in-process-unsafe',
      budget: { maxSubLlmCalls: 10, maxCostUsd: 0.01 },
    });
    const { subAgentQuery } = toolsFor(session);

    await expireDeadline(subAgentQuery({ prompt: 'hi' }));

    // Booking $0 for the first abort left the cap exactly where it started,
    // so a caller could keep paying for aborted generations indefinitely.
    // Run through `expireDeadline` rather than asserting `rejects` directly:
    // the refusal is synchronous at reservation, so a regression DISPATCHES
    // instead - and a dispatched call hangs on the mocked signal until the
    // test times out. This way the regression reports the wrong error type
    // immediately instead of a 30s timeout.
    const second = await expireDeadline(subAgentQuery({ prompt: 'hi' }));
    expect(second).toBeInstanceOf(BudgetExceededError);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('still releases the slot when the dispatch itself fails before the provider', async () => {
    // The contrast that makes the settle-on-abort correct rather than a
    // blanket "book everything": nothing was billed here, so the slot and
    // the money both have to come back.
    createSpy.mockReset();
    createSpy.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));

    const session = new ReplSession({
      sessionId: 'abort-contrast',
      executor: 'in-process-unsafe',
      budget: { maxSubLlmCalls: 1, maxCostUsd: 1000 },
    });
    const { subAgentQuery } = toolsFor(session);

    await expect(subAgentQuery({ prompt: 'hi' })).rejects.toThrow(/ENOTFOUND/);
    expect(session.getUsage().subLlmCalls).toBe(0);
    expect(session.getUsage().totalCostUsd).toBe(0);
  });
});

describe('subAgentQuery output-ceiling reporting', () => {
  beforeEach(() => {
    createSpy.mockReset();
  });

  it('surfaces an answer the output ceiling cut off instead of returning it as complete', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'partial answer' }],
      usage: { input_tokens: 10, output_tokens: 2000 },
      stop_reason: 'max_tokens',
    });

    const session = new ReplSession({ sessionId: 'stop-reason', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    const out = await subAgentQuery({ prompt: 'hi', max_tokens: 2000 });

    expect(out).toContain('partial answer');
    expect(out).toMatch(/hit the 2000-token output ceiling/);
  });

  it('leaves an answer that stopped on its own untouched', async () => {
    createSpy.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'complete answer' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });

    const session = new ReplSession({ sessionId: 'end-turn', executor: 'in-process-unsafe' });
    const { subAgentQuery } = toolsFor(session);

    expect(await subAgentQuery({ prompt: 'hi' })).toBe('complete answer');
  });
});
