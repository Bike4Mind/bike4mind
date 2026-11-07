import { describe, expect, it } from 'vitest';
import {
  acceptTask,
  automaticUpgradeAllowed,
  inheritancePolicy,
  renderTaskBrief,
  resolveWorkerModel,
  spawnOptionsSchema,
  taskContractSchema,
  validateWorkerModel,
  workerTaskSchema,
  type TaskContract,
  type WorkerTask,
} from './orchestration';

export const contract: TaskContract = {
  version: 1,
  outcome: 'Implement a bounded change',
  rationale: 'Avoid duplicate work',
  role: 'implementation',
  paths: ['src/feature.ts'],
  contextReferences: [],
  ownedChanges: ['src/feature.ts'],
  coordinationConstraints: ['Keep the public interface'],
  nonGoals: [],
  acceptanceCriteria: ['Focused behavior passes'],
  verification: ['pnpm test feature'],
  assumptions: ['The current interface is sufficient'],
  escalationConditions: ['Interface needs to change'],
};
export const task = (): WorkerTask => ({
  version: 1,
  contract,
  automaticUpgrades: 0,
  resolvedDecisions: [],
  attempts: [{ id: 'attempt-1', model: 'worker', startedAt: '2026-11-07', trigger: 'initial' }],
  state: { status: 'running' },
});

describe('orchestration contracts and role routing', () => {
  it('preserves legacy inheritance and resolves explicit roles and permitted overrides', () => {
    const policy = {
      ...inheritancePolicy(),
      roles: { implementation: 'worker', exploration: 'scout', review: 'inherit' },
      allowedOverrides: ['alternative'],
    };
    expect(resolveWorkerModel('planner', policy, {})).toMatchObject({ effectiveModel: 'planner', source: 'parent' });
    expect(resolveWorkerModel('planner', policy, { role: 'implementation' })).toMatchObject({
      effectiveModel: 'worker',
      source: 'role-policy',
    });
    expect(resolveWorkerModel('worker', policy, { role: 'exploration' })).toMatchObject({ effectiveModel: 'scout' });
    expect(resolveWorkerModel('planner', policy, { role: 'review' })).toMatchObject({ effectiveModel: 'planner' });
    expect(
      resolveWorkerModel('planner', policy, { role: 'implementation', requestedModelId: 'alternative' })
    ).toMatchObject({ effectiveModel: 'alternative', source: 'override' });
    expect(resolveWorkerModel('planner', policy, { requestedModelId: 'planner' })).toMatchObject({
      effectiveModel: 'planner',
    });
    expect(() => resolveWorkerModel('planner', policy, { requestedModelId: 'unauthorized' })).toThrow(/explicit user/);
  });
  it('validates a self-contained bounded contract and explicit empty sections', () => {
    expect(taskContractSchema.parse(contract)).toEqual(contract);
    expect(renderTaskBrief(contract)).toContain('Focused behavior passes');
    expect(renderTaskBrief(contract)).toContain('Context references:\n(none)');
    expect(taskContractSchema.safeParse({ ...contract, acceptanceCriteria: [] }).success).toBe(false);
    expect(taskContractSchema.safeParse({ ...contract, transcript: 'do not copy' }).success).toBe(false);
    expect(taskContractSchema.safeParse({ ...contract, outcome: 'x'.repeat(2001) }).success).toBe(false);
    expect(taskContractSchema.safeParse({ ...contract, paths: Array(32).fill('x'.repeat(1000)) }).success).toBe(false);
    expect(spawnOptionsSchema.safeParse({ contract, role: 'review' }).success).toBe(false);
    expect(spawnOptionsSchema.parse({})).toEqual({});
  });
  it('blocks catalog, access, tools, vision, context and local privacy failures without substitution', () => {
    for (const models of [
      [],
      [{ id: 'worker', name: 'Worker', unavailable: 'server offline' }],
      [{ id: 'worker', name: 'Worker', disabled: true }],
      [{ id: 'worker', name: 'Worker', supportsTools: false }],
    ]) {
      expect(() => validateWorkerModel('worker', models, { localOnly: false })).toThrow(/blocked/);
    }
    const models = [{ id: 'worker', name: 'Worker', supportsTools: true, supportsVision: false, contextWindow: 1000 }];
    expect(() => validateWorkerModel('worker', models, { localOnly: true })).toThrow(/device-local/);
    expect(() => validateWorkerModel('worker', models, { localOnly: false, vision: true })).toThrow(/images/);
    expect(() => validateWorkerModel('worker', models, { localOnly: false, contextTokens: 2000 })).toThrow(/context/);
    expect(() => validateWorkerModel('worker', models, { localOnly: false })).not.toThrow();
    expect(() =>
      validateWorkerModel('unknown', [{ id: 'unknown', name: 'Unknown' }], { localOnly: false, vision: true })
    ).toThrow(/images/);
    expect(() =>
      validateWorkerModel('unknown', [{ id: 'unknown', name: 'Unknown' }], { localOnly: false, contextTokens: 1000 })
    ).toThrow(/context/);
  });
  it('requires evidence for every criterion and keeps failed checks visible', () => {
    const completed: WorkerTask = {
      ...task(),
      state: {
        status: 'completed',
        accepted: false,
        changedPaths: ['src/feature.ts'],
        verification: [
          {
            criterion: contract.acceptanceCriteria[0],
            command: 'pnpm test feature',
            outcome: 'passed',
            evidence: '1 focused behavioral test passed',
          },
        ],
        unmetCriteria: [],
        handoff: 'Ready for review',
      },
    };
    expect(acceptTask(completed, 'Reviewed behavior')).toMatchObject({
      state: { accepted: true, assessment: 'Reviewed behavior' },
    });
    expect(() => acceptTask(task(), 'Turn ended')).toThrow(/Acceptance/);
    if (completed.state.status !== 'completed') throw new Error('Fixture invalid');
    const completedState = completed.state;
    expect(() => acceptTask({ ...completed, state: { ...completedState, verification: [] } }, 'No checks')).toThrow();
    expect(() =>
      acceptTask({ ...completed, state: { ...completedState, unmetCriteria: ['Still broken'] } }, 'Ignored')
    ).toThrow();
    expect(() =>
      acceptTask(
        {
          ...completed,
          state: {
            ...completedState,
            verification: [
              ...completedState.verification,
              { criterion: 'Other check', command: 'test', outcome: 'failed', evidence: 'Regression' },
            ],
          },
        },
        'Ignored'
      )
    ).toThrow();
    expect(workerTaskSchema.parse(JSON.parse(JSON.stringify(completed)))).toEqual(completed);
  });
  it('requires budget admission, role/model allowlists and a single automatic upgrade maximum', () => {
    const policy = {
      ...inheritancePolicy(),
      escalation: {
        mode: 'automatic' as const,
        allowedModels: ['premium'],
        allowedRoles: ['implementation' as const],
        maxAutomaticUpgrades: 1 as const,
      },
    };
    const pending: WorkerTask = {
      ...task(),
      state: {
        status: 'escalation-requested',
        decisionId: 'decision-1',
        reason: 'Invalid assumption',
        evidence: ['Focused test failed'],
        requestedModelId: 'premium',
      },
    };
    expect(automaticUpgradeAllowed(pending, policy, 'premium', false)).toBe(false);
    expect(automaticUpgradeAllowed(pending, policy, 'premium', true)).toBe(true);
    expect(automaticUpgradeAllowed({ ...pending, automaticUpgrades: 1 }, policy, 'premium', true)).toBe(false);
    expect(automaticUpgradeAllowed(pending, policy, 'unlisted', true)).toBe(false);
    expect(
      automaticUpgradeAllowed(
        pending,
        { ...policy, escalation: { ...policy.escalation, allowedRoles: ['review'] } },
        'premium',
        true
      )
    ).toBe(false);
  });
});
