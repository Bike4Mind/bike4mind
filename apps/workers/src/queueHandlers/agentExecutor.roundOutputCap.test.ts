import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CREDITS_PER_USD_COST, type IMessage, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';
import {
  UnaffordableRoundError,
  capAgentRoundOutput,
  capsRoundOutput,
  outOfCreditsOutcome,
  type RoundOutputCapArgs,
} from './agentExecutor.roundOutputCap';

// $1/M input, $10/M output on one tier.
const MODEL = {
  id: 'round-cap-test-model',
  backend: 'anthropic',
  max_tokens: 8192,
  pricing: { 1_000_000: { input: 1 / 1_000_000, output: 10 / 1_000_000 } },
} as unknown as ModelInfo;
const perOutputTokenCredits = (10 / 1_000_000) * CREDITS_PER_USD_COST;

const MESSAGES: IMessage[] = [{ role: 'user', content: 'x'.repeat(250) }]; // ~100 estimated input tokens

function fakeBackend() {
  const complete = vi.fn<ICompletionBackend['complete']>(async () => undefined);
  return { backend: { complete } as unknown as ICompletionBackend, complete };
}

function capArgs(overrides: Partial<RoundOutputCapArgs> = {}): RoundOutputCapArgs {
  return {
    modelInfo: MODEL,
    readBalance: async () => 1_000_000,
    lastInputTokens: () => 0,
    isActive: () => true,
    logger: { info: vi.fn() },
    ...overrides,
  };
}

async function sendRound(backend: ICompletionBackend, options: Partial<ICompletionOptions>) {
  await backend.complete(MODEL.id, MESSAGES, options as ICompletionOptions, async () => undefined);
}

function sentOptions(complete: ReturnType<typeof fakeBackend>['complete']): Partial<ICompletionOptions> {
  expect(complete).toHaveBeenCalledTimes(1);
  return complete.mock.calls[0]![2];
}

describe('capAgentRoundOutput', () => {
  it('lowers the output budget to what the balance can pay for after the input', async () => {
    const { backend, complete } = fakeBackend();
    const balance = 20;
    await sendRound(capAgentRoundOutput(backend, capArgs({ readBalance: async () => balance })), { maxTokens: 8000 });

    const options = sentOptions(complete);
    expect(options.maxTokens).toBeLessThan(8000);
    expect(options.outputTokenCeiling).toBe(options.maxTokens);
    // Input plus a full-length answer stays within the balance.
    expect(options.maxTokens! * perOutputTokenCredits).toBeLessThanOrEqual(balance);
    // And only the (small) input is held back from it.
    expect(options.maxTokens).toBeGreaterThanOrEqual(Math.floor((balance - 1) / perOutputTokenCredits));
  });

  it('keeps the requested budget, with the ceiling set, when the balance covers it', async () => {
    const { backend, complete } = fakeBackend();
    await sendRound(capAgentRoundOutput(backend, capArgs()), { maxTokens: 4000 });

    const options = sentOptions(complete);
    expect(options.maxTokens).toBe(4000);
    expect(options.outputTokenCeiling).toBeGreaterThan(4000);
  });

  it('caps a run without its own maxTokens only below the model output limit', async () => {
    const rich = fakeBackend();
    await sendRound(capAgentRoundOutput(rich.backend, capArgs()), { temperature: 0.5 });
    expect(sentOptions(rich.complete)).toEqual({ temperature: 0.5 });

    const poor = fakeBackend();
    await sendRound(capAgentRoundOutput(poor.backend, capArgs({ readBalance: async () => 20 })), {});
    const options = sentOptions(poor.complete);
    expect(options.maxTokens).toBeLessThan(MODEL.max_tokens);
    expect(options.outputTokenCeiling).toBe(options.maxTokens);
  });

  it('prices the round at no less than the last request the run sent', async () => {
    // Input at the 5-minute cache-write rate (1.25x) that uses about half of the 50-credit balance.
    const halfBalanceInputTokens = Math.floor(25 / ((1.25 / 1_000_000) * CREDITS_PER_USD_COST));
    const estimated = fakeBackend();
    await sendRound(capAgentRoundOutput(estimated.backend, capArgs({ readBalance: async () => 50 })), {
      maxTokens: 8000,
    });
    const floored = fakeBackend();
    await sendRound(
      capAgentRoundOutput(
        floored.backend,
        capArgs({ readBalance: async () => 50, lastInputTokens: () => halfBalanceInputTokens })
      ),
      { maxTokens: 8000 }
    );

    expect(sentOptions(floored.complete).maxTokens).toBeLessThan(sentOptions(estimated.complete).maxTokens!);
  });

  it('refuses the round without calling the model when even a short answer is unaffordable', async () => {
    const { backend, complete } = fakeBackend();
    const capped = capAgentRoundOutput(backend, capArgs({ readBalance: async () => 1 }));

    const error = await sendRound(capped, { maxTokens: 8000 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UnaffordableRoundError);
    expect(error).toMatchObject({ balance: 1 });
    expect((error as UnaffordableRoundError).minimumCredits).toBeGreaterThan(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('passes the round through untouched, without reading the balance, when inactive', async () => {
    const { backend, complete } = fakeBackend();
    const readBalance = vi.fn(async () => 0);
    await sendRound(capAgentRoundOutput(backend, capArgs({ readBalance, isActive: () => false })), { maxTokens: 8000 });

    expect(sentOptions(complete)).toEqual({ maxTokens: 8000 });
    expect(readBalance).not.toHaveBeenCalled();
  });
});

describe('capsRoundOutput', () => {
  const freeAccount = { enforceCredits: true, billedToOrganization: false, readHasPaidPlan: async () => false };

  it('caps a personal account without a paid plan', async () => {
    await expect(capsRoundOutput(freeAccount)).resolves.toBe(true);
  });

  it('caps when the plan cannot be read', async () => {
    const readHasPaidPlan = () => Promise.reject(new Error('entitlements unavailable'));
    await expect(capsRoundOutput({ ...freeAccount, readHasPaidPlan })).resolves.toBe(true);
  });

  it('leaves paid plans, organizations and unenforced credits uncapped', async () => {
    await expect(capsRoundOutput({ ...freeAccount, readHasPaidPlan: async () => true })).resolves.toBe(false);
    const readHasPaidPlan = vi.fn(async () => false);
    await expect(capsRoundOutput({ ...freeAccount, billedToOrganization: true, readHasPaidPlan })).resolves.toBe(false);
    await expect(capsRoundOutput({ ...freeAccount, enforceCredits: false, readHasPaidPlan })).resolves.toBe(false);
    expect(readHasPaidPlan).not.toHaveBeenCalled();
  });
});

describe('outOfCreditsOutcome', () => {
  it('turns a refused round into an outcome and rethrows anything else', () => {
    const refusal = new UnaffordableRoundError(1, 5);
    expect(outOfCreditsOutcome(refusal)).toEqual({ kind: 'out-of-credits', error: refusal });
    const other = new Error('provider down');
    expect(() => outOfCreditsOutcome(other)).toThrow(other);
  });
});

describe('processExecution wiring', () => {
  const source = readFileSync(resolve(__dirname, 'agentExecutor.ts'), 'utf8');

  it('runs the agent on the capped backend and toggles the cap with the credit gate', () => {
    expect(source).toContain('llm: agentLlm,');
    expect(source).toMatch(/capsRounds && modelInfo\s+\? capAgentRoundOutput\(llm, \{/);
    expect(source).toContain('roundCapActive = gateThisIteration;');
  });

  it('stops the run as out of credits when a round is refused', () => {
    expect(source).toContain('.catch(outOfCreditsOutcome);');
    expect(source).toMatch(/if \(deadlineOutcome\.kind === 'out-of-credits'\) \{[\s\S]*?await stopOutOfCredits\(/);
  });
});
