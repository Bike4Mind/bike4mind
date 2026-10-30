import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentStep } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import { nextIterationCredits } from './agentExecutor.billing';
import {
  aggregationWakeStartIteration,
  aggregationGraceReasonOf,
  refusesUnrunnableModel,
  shouldGateIteration,
  stopBlockedAccountIteration,
  stopUnfundedIteration,
} from './agentExecutor.iterationCreditGate';

const model = {
  id: 'claude-sonnet-4-6',
  backend: 'bedrock',
  max_tokens: 4096,
  pricing: { 1_000_000: { input: 0.000003, output: 0.000015 } },
} as unknown as ModelInfo;
/** What one iteration at a fixed input size reserves. */
const required = (inputTokens = 0) => nextIterationCredits(model, inputTokens);

const steps = [{ role: 'assistant', content: 'partial step' }] as unknown as AgentStep[];

function makeDeps() {
  return {
    markFailed: vi.fn().mockResolvedValue(undefined),
    sendWs: vi.fn().mockResolvedValue(undefined),
    persistRunAsQuest: vi.fn().mockResolvedValue(undefined),
    logger: { warn: vi.fn() },
  };
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'exec-1',
    iterationIndex: 2,
    modelInfo: model,
    lastInputTokens: 0,
    readBalance: vi.fn().mockResolvedValue(required()),
    checkSpendCap: vi.fn().mockResolvedValue(null),
    snapshot: vi.fn().mockReturnValue({ steps, partialAnswer: 'partial answer' as string | undefined }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('stopUnfundedIteration', () => {
  it('fails a run one credit short of the next iteration, keeping its partial answer', async () => {
    const deps = makeDeps();

    await expect(
      stopUnfundedIteration(args({ readBalance: vi.fn().mockResolvedValue(required() - 1) }), deps)
    ).resolves.toBe(true);

    expect(deps.markFailed).toHaveBeenCalledWith('exec-1', {
      message: 'Insufficient credits to continue agent execution',
    });
    expect(deps.sendWs).toHaveBeenCalledWith('failed', {
      executionId: 'exec-1',
      reason: 'insufficient_credits',
      partialResult: steps,
    });
    expect(deps.persistRunAsQuest).toHaveBeenCalledWith(
      'exec-1',
      'Stopped: out of credits. Partial response:\n\npartial answer'
    );
  });

  it('treats a missing holder as a zero balance', async () => {
    const deps = makeDeps();

    await expect(stopUnfundedIteration(args({ readBalance: vi.fn().mockResolvedValue(0) }), deps)).resolves.toBe(true);
  });

  it('lets the iteration run when the payer covers it, without snapshotting the agent', async () => {
    const deps = makeDeps();
    const gateArgs = args();
    Object.assign(gateArgs, { snapshot: vi.fn().mockReturnValue({ steps, partialAnswer: 'partial answer' }) });

    await expect(stopUnfundedIteration(gateArgs, deps)).resolves.toBe(false);

    expect(gateArgs.snapshot).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
    expect(deps.sendWs).not.toHaveBeenCalled();
    expect(deps.persistRunAsQuest).not.toHaveBeenCalled();
  });

  it('prices the next iteration at the size the last one sent, so a grown context stops it', async () => {
    const balance = required(0);
    const deps = makeDeps();
    const readBalance = vi.fn().mockResolvedValue(balance);

    await expect(stopUnfundedIteration(args({ lastInputTokens: 0, readBalance }), deps)).resolves.toBe(false);
    await expect(stopUnfundedIteration(args({ lastInputTokens: 100_000, readBalance }), deps)).resolves.toBe(true);
  });

  it('stops a funded iteration that would take a new account over its spend cap, before the model call', async () => {
    const deps = makeDeps();
    const capMessage = 'New accounts can spend up to 10,000 credits per hour; this resets at 12:11 UTC.';
    const checkSpendCap = vi.fn().mockResolvedValue(capMessage);

    await expect(
      stopUnfundedIteration(
        args({ lastInputTokens: 5_000, readBalance: vi.fn().mockResolvedValue(required(5_000)), checkSpendCap }),
        deps
      )
    ).resolves.toBe(true);

    expect(checkSpendCap).toHaveBeenCalledWith(required(5_000));
    expect(deps.markFailed).toHaveBeenCalledWith('exec-1', { message: capMessage });
    expect(deps.sendWs).toHaveBeenCalledWith('failed', {
      executionId: 'exec-1',
      reason: 'insufficient_credits',
      partialResult: steps,
    });
    expect(deps.persistRunAsQuest).toHaveBeenCalledWith(
      'exec-1',
      `Stopped: ${capMessage} Partial response:\n\npartial answer`
    );
  });

  it('does not read the spend cap when the balance already stops the run', async () => {
    const deps = makeDeps();
    const checkSpendCap = vi.fn();

    await expect(
      stopUnfundedIteration(args({ readBalance: vi.fn().mockResolvedValue(0), checkSpendCap }), deps)
    ).resolves.toBe(true);
    expect(checkSpendCap).not.toHaveBeenCalled();
  });

  it('stops with the plain message when the run produced no partial answer', async () => {
    const deps = makeDeps();
    const gateArgs = args({ readBalance: vi.fn().mockResolvedValue(0) });
    Object.assign(gateArgs, { snapshot: vi.fn().mockReturnValue({ steps: [], partialAnswer: undefined }) });

    await expect(stopUnfundedIteration(gateArgs, deps)).resolves.toBe(true);

    expect(deps.persistRunAsQuest).toHaveBeenCalledWith('exec-1', 'Stopped: out of credits.');
  });
});

describe('stopBlockedAccountIteration', () => {
  const denial = 'Account suspended pending dispute resolution. Please contact support.';
  const gateArgs = (readAccessDenial: () => Promise<string | null>) => ({
    executionId: 'exec-1',
    readAccessDenial,
    snapshot: vi.fn().mockReturnValue({ steps, partialAnswer: 'partial answer' }),
  });

  it('stops a run whose account was blocked since it was admitted, before the next iteration', async () => {
    const deps = makeDeps();

    await expect(
      stopBlockedAccountIteration(
        gateArgs(async () => denial),
        deps
      )
    ).resolves.toBe(true);

    expect(deps.markFailed).toHaveBeenCalledWith('exec-1', { message: denial });
    expect(deps.sendWs).toHaveBeenCalledWith('failed', {
      executionId: 'exec-1',
      reason: 'account_blocked',
      partialResult: steps,
    });
    expect(deps.persistRunAsQuest).toHaveBeenCalledWith('exec-1', `Stopped: ${denial}`);
  });

  it('lets an active account run, without snapshotting the agent', async () => {
    const deps = makeDeps();
    const args = gateArgs(async () => null);

    await expect(stopBlockedAccountIteration(args, deps)).resolves.toBe(false);

    expect(args.snapshot).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });
});

describe('aggregationWakeStartIteration', () => {
  it('exempts the resuming iteration of an aggregation wake and nothing else', () => {
    expect(aggregationWakeStartIteration(true, 4)).toBe(4);
    expect(aggregationWakeStartIteration(false, 4)).toBe(-1);
  });
});

describe('shouldGateIteration', () => {
  const policy = { enforceCredits: true, hasModel: true, iterationIndex: 0, wakeStartIteration: -1 };

  it('gates the first iteration of a normal run', () => {
    expect(shouldGateIteration(policy)).toBe(true);
  });

  it("leaves a wake's wrap-up iteration ungated and gates the one after it", () => {
    const wake = { ...policy, iterationIndex: 3, wakeStartIteration: 3 };

    expect(shouldGateIteration(wake)).toBe(false);
    expect(shouldGateIteration({ ...wake, iterationIndex: 4 })).toBe(true);
  });

  it('does not gate with enforcement off or no resolved model', () => {
    expect(shouldGateIteration({ ...policy, enforceCredits: false })).toBe(false);
    expect(shouldGateIteration({ ...policy, hasModel: false })).toBe(false);
  });
});

describe('refusesUnrunnableModel', () => {
  it('refuses a disabled or unentitled model on a normal run', () => {
    expect(refusesUnrunnableModel({ hasModel: true, isRunnable: false, isAggregationOnlyWake: false })).toBe(true);
  });

  it('does not refuse an aggregation wake, whose children already ran', () => {
    expect(refusesUnrunnableModel({ hasModel: true, isRunnable: false, isAggregationOnlyWake: true })).toBe(false);
  });

  it('does not refuse a runnable or unresolved model', () => {
    expect(refusesUnrunnableModel({ hasModel: true, isRunnable: true, isAggregationOnlyWake: false })).toBe(false);
    expect(refusesUnrunnableModel({ hasModel: false, isRunnable: false, isAggregationOnlyWake: false })).toBe(false);
  });
});

/**
 * The helpers above decide correctly in isolation; these pin the loop's wiring to them, which a
 * deleted or re-pointed call site would otherwise leave green.
 */
describe('processExecution iteration-gate wiring', () => {
  const source = readFileSync(resolve(__dirname, 'agentExecutor.ts'), 'utf8');
  /**
   * The body between the loop marker and the post-iteration permission check, which follows the
   * checkpoint write and the next-iteration size refresh.
   */
  const loopSource = (() => {
    const start = source.indexOf('// --- Iteration loop ---');
    const end = source.indexOf('// Permission check.');
    if (start < 0 || end <= start) throw new Error('iteration loop markers not found');
    return source.slice(start, end);
  })();

  it('consults the gate before every iteration the policy allows', () => {
    expect(loopSource).toContain('const gateThisIteration = shouldGateIteration({');
    expect(loopSource).toContain('wakeStartIteration: aggregationWakeStartIteration,');
    expect(loopSource).toMatch(/readBalance: \(\) =>\s+readPayerBalance\(\{/);
    expect(loopSource).toMatch(/if \(gateThisIteration && modelInfo\) \{/);
    expect(loopSource).toMatch(/const stopped = await stopUnfundedIteration\(/);
    expect(loopSource).toMatch(/if \(stopped\) return;/);
  });

  it('re-reads the account state before every iteration, ahead of the credit gate', () => {
    const accountGate = loopSource.indexOf('const blocked = await stopBlockedAccountIteration(');
    expect(accountGate).toBeGreaterThanOrEqual(0);
    expect(accountGate).toBeLessThan(loopSource.indexOf('const gateThisIteration = shouldGateIteration({'));
    expect(loopSource).toContain('readAccessDenial: () => readUserAccessDenial((user as IUserDocument).id),');
    expect(loopSource).toMatch(/if \(blocked\) return;/);
  });

  it('grows the next estimate from the iteration that just ran', () => {
    expect(loopSource).toContain(
      'lastInputTokens = lastRequestInputTokens(iterationResult.checkpoint.turnUsage) || lastInputTokens;'
    );
  });

  it('builds the wake, model and clamp decisions from the extracted helpers', () => {
    expect(source).toContain(
      'const aggregationWakeStartIteration = wakeStartIterationOf(isAggregationOnlyWake, iterationIndex);'
    );
    expect(source).toContain(
      'if (refusesUnrunnableModel({ hasModel: Boolean(modelInfo), isRunnable: modelRunnable, isAggregationOnlyWake })) {'
    );
    const clampCall = source.match(
      /maxIterations = clampMaxIterationsForUnrunnableAggregationWake\(\{([\s\S]*?)\n {4}\}\);/
    );
    expect(clampCall).not.toBeNull();
    expect(clampCall![1]).toContain('isRunnable: !modelInfo || (modelAccess.ok && modelRunnable),');
    const reasonCall = source.match(/aggregationGraceReason: aggregationGraceReasonOf\(\{([^{}]*?)\}\)/);
    expect(reasonCall).not.toBeNull();
    expect(reasonCall![1]).toContain('modelAccessOk: modelAccess.ok,');
    expect(reasonCall![1]).toContain('hasModel: Boolean(modelInfo),');
    expect(reasonCall![1]).toContain('isRunnable: modelRunnable,');
  });
});

describe('aggregationGraceReasonOf', () => {
  it.each([
    [false, true, false, true, undefined],
    [true, true, false, false, 'model-unavailable'],
    [true, true, false, true, 'model-unavailable'],
    [true, true, true, true, 'credit-cap'],
    [true, true, true, false, undefined],
    [true, false, false, false, undefined],
  ] as const)(
    'selects the actual clamp reason (%s, %s, %s, %s)',
    (isAggregationOnlyWake, hasModel, isRunnable, isOverCap, expected) => {
      expect(
        aggregationGraceReasonOf({ isAggregationOnlyWake, hasModel, isRunnable, isOverCap, modelAccessOk: true })
      ).toBe(expected);
    }
  );
});

describe('aggregation model configuration failures', () => {
  it('distinguishes a transient lookup failure from a disabled model', () => {
    expect(
      aggregationGraceReasonOf({
        isAggregationOnlyWake: true,
        hasModel: true,
        isRunnable: false,
        isOverCap: false,
        modelAccessOk: false,
      })
    ).toBe('model-configuration-unavailable');
    expect(
      aggregationGraceReasonOf({
        isAggregationOnlyWake: false,
        hasModel: true,
        isRunnable: false,
        isOverCap: false,
        modelAccessOk: false,
      })
    ).toBeUndefined();
  });
});
