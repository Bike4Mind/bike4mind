import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentStep } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';

const { findUserById, findOrganizationById } = vi.hoisted(() => ({
  findUserById: vi.fn(),
  findOrganizationById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...args: unknown[]) => findUserById(...args) },
  organizationRepository: { findById: (...args: unknown[]) => findOrganizationById(...args) },
}));

import { nextIterationCredits } from './agentExecutor.billing';
import { stopUnfundedIteration } from './agentExecutor.iterationCreditGate';

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
    userId: 'user-1',
    organization: null as { id: string } | null,
    modelInfo: model,
    lastInputTokens: 0,
    snapshot: vi.fn().mockReturnValue({ steps, partialAnswer: 'partial answer' as string | undefined }),
    ...overrides,
  };
}

beforeEach(() => {
  findUserById.mockReset();
  findOrganizationById.mockReset();
});

describe('stopUnfundedIteration', () => {
  it('fails a user-billed run one credit short of the next iteration, keeping its partial answer', async () => {
    findUserById.mockResolvedValue({ id: 'user-1', currentCredits: required() - 1 });
    const deps = makeDeps();

    await expect(stopUnfundedIteration(args(), deps)).resolves.toBe(true);

    expect(findUserById).toHaveBeenCalledWith('user-1');
    expect(findOrganizationById).not.toHaveBeenCalled();
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

  it('reads the organization pool, not the user, when the run is organization-billed', async () => {
    findOrganizationById.mockResolvedValue({ id: 'org-1', currentCredits: required() - 1 });
    findUserById.mockResolvedValue({ id: 'user-1', currentCredits: 1_000_000 });
    const deps = makeDeps();

    await expect(stopUnfundedIteration(args({ organization: { id: 'org-1' } }), deps)).resolves.toBe(true);

    expect(findOrganizationById).toHaveBeenCalledWith('org-1');
    expect(findUserById).not.toHaveBeenCalled();
  });

  it('lets the iteration run when the payer covers it, without snapshotting the agent', async () => {
    findUserById.mockResolvedValue({ id: 'user-1', currentCredits: required() });
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
    findUserById.mockResolvedValue({ id: 'user-1', currentCredits: balance });
    const deps = makeDeps();

    await expect(stopUnfundedIteration(args({ lastInputTokens: 0 }), deps)).resolves.toBe(false);
    await expect(stopUnfundedIteration(args({ lastInputTokens: 100_000 }), deps)).resolves.toBe(true);
  });

  it('stops with the plain message when the run produced no partial answer', async () => {
    findUserById.mockResolvedValue({ id: 'user-1', currentCredits: 0 });
    const deps = makeDeps();
    const gateArgs = args();
    Object.assign(gateArgs, { snapshot: vi.fn().mockReturnValue({ steps: [], partialAnswer: undefined }) });

    await expect(stopUnfundedIteration(gateArgs, deps)).resolves.toBe(true);

    expect(deps.persistRunAsQuest).toHaveBeenCalledWith('exec-1', 'Stopped: out of credits.');
  });
});

/**
 * The helper above decides correctly in isolation; these pin the loop's wiring to it, which a
 * deleted or re-pointed call site would otherwise leave green.
 */
describe('processExecution iteration-gate wiring', () => {
  const source = readFileSync(resolve(__dirname, 'agentExecutor.ts'), 'utf8');

  it('consults the gate before every iteration that is not an aggregation wake\'s wrap-up', () => {
    expect(source).toMatch(/if \(gateIterations && modelInfo && iterationIndex !== aggregationWakeStartIteration\)/);
    expect(source).toMatch(/const stopped = await stopUnfundedIteration\(/);
    expect(source).toMatch(/if \(stopped\) return;/);
  });

  it('grows the next estimate from the iteration that just ran', () => {
    expect(source).toContain(
      'lastInputTokens = lastRequestInputTokens(iterationResult.checkpoint.turnUsage) || lastInputTokens;'
    );
  });
});
