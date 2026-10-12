import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { DecisionOverloadedError, decideWithRetry } from './retry';
import { DecisionProviderError, type DecisionProvider, type ProviderDecision } from './types';

const DECISION: ProviderDecision = {
  model: 'gpt-6-luna',
  answers: [{ type: 'predicate', probability: 0.5 }],
  usage: { inputTokens: 1, outputTokens: 0 },
};
const overloaded = (retryAfterMs?: number) =>
  new DecisionProviderError('overloaded', 'busy', { status: 529, retryAfterMs });

const providerFailing = (...outcomes: (ProviderDecision | Error)[]): DecisionProvider => {
  const decide = vi.fn(async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? DECISION;
  });
  return { id: 'openaiDecisions', models: ['gpt-6-luna'], decide };
};

const run = (provider: DecisionProvider, overrides: { deadlineMs?: number; now?: () => number } = {}) => {
  const sleep = vi.fn(async () => undefined);
  const result = decideWithRetry({
    provider,
    request: { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'predicate', name: 'p', instructions: 'p' }] },
    apiKey: 'k',
    logger: new Logger(),
    deadlineMs: overrides.deadlineMs ?? 10_000,
    now: overrides.now ?? (() => 0),
    sleep,
    random: () => 0.5,
  });
  return { result, sleep };
};

describe('decideWithRetry', () => {
  it('returns the first answer without retrying', async () => {
    const provider = providerFailing(DECISION);
    await expect(run(provider).result).resolves.toEqual({ decision: DECISION, retries: 0 });
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it('retries the same model once after jitter, and reports the retry', async () => {
    const provider = providerFailing(overloaded(), DECISION);
    const { result, sleep } = run(provider);
    await expect(result).resolves.toEqual({ decision: DECISION, retries: 1 });
    expect(sleep).toHaveBeenCalledWith(250);
    expect(provider.decide).toHaveBeenCalledTimes(2);
  });

  it("waits the vendor's retry-after when it fits in the deadline", async () => {
    const { result, sleep } = run(providerFailing(overloaded(2_000), DECISION));
    await result;
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('gives up without retrying when retry-after would overrun the deadline', async () => {
    const provider = providerFailing(overloaded(20_000));
    await expect(run(provider).result).rejects.toMatchObject({ retries: 0, retryAfterSeconds: 20 });
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it('gives up at once when the wait would leave the retry too little of the deadline', async () => {
    const provider = providerFailing(overloaded(9_000));
    await expect(run(provider).result).rejects.toMatchObject({ retries: 0, retryAfterSeconds: 9 });
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it('gives the retry only what is left of the deadline, and maps its timeout to overloaded', async () => {
    let clock = 0;
    const signals: AbortSignal[] = [];
    const hangsUntilAborted: DecisionProvider = {
      id: 'openaiDecisions',
      models: ['gpt-6-luna'],
      decide: vi.fn(async (_request, { signal }) => {
        signals.push(signal);
        if (signals.length === 1) {
          clock = 7_500;
          throw overloaded();
        }
        return new Promise<ProviderDecision>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason))
        );
      }),
    };
    const startedAt = Date.now();
    const { result } = run(hangsUntilAborted, { now: () => clock });

    await expect(result).rejects.toMatchObject({ retries: 1 });
    expect(signals[1].aborted).toBe(true);
    // 10s deadline minus 7.5s already spent; the full 10s would mean the budget is ignored.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('surfaces an adapter bug instead of retrying it as overload', async () => {
    const provider = providerFailing(new TypeError("Cannot read properties of undefined (reading 'answers')"));
    await expect(run(provider).result).rejects.toBeInstanceOf(TypeError);
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it('throws DecisionOverloadedError after the one retry is spent', async () => {
    const provider = providerFailing(overloaded(), overloaded());
    await expect(run(provider).result).rejects.toBeInstanceOf(DecisionOverloadedError);
    expect(provider.decide).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error the retry cannot fix', async () => {
    const provider = providerFailing(new DecisionProviderError('rejected_key', 'bad key'));
    await expect(run(provider).result).rejects.toMatchObject({ kind: 'rejected_key' });
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });
});
