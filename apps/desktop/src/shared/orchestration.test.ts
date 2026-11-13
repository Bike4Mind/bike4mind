import { describe, expect, it } from 'vitest';
import type { ChatModelOption } from './chat';
import {
  acceptTask,
  assertReportCoversCriteria,
  automaticUpgradeAllowed,
  inheritancePolicy,
  modelRequestHint,
  renderTaskBrief,
  resolveModelAlias,
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
    expect(() =>
      resolveWorkerModel('planner', policy, { role: 'implementation', requestedModelId: 'planner' })
    ).toThrow(/^Model request refused: /);
    expect(resolveWorkerModel('planner', policy, { role: 'review', requestedModelId: 'planner' })).toMatchObject({
      effectiveModel: 'planner',
    });
    expect(
      resolveWorkerModel(
        'planner',
        { ...policy, allowedOverrides: ['planner'] },
        { role: 'implementation', requestedModelId: 'planner' }
      )
    ).toMatchObject({ effectiveModel: 'planner', source: 'override' });
    expect(
      resolveWorkerModel('planner', policy, { role: 'implementation', requestedModelId: 'alternative' })
    ).toMatchObject({ effectiveModel: 'alternative', source: 'override' });
    expect(resolveWorkerModel('planner', policy, { requestedModelId: 'planner' })).toMatchObject({
      effectiveModel: 'planner',
    });
    expect(() => resolveWorkerModel('planner', policy, { requestedModelId: 'unauthorized' })).toThrow(
      /^Model request refused: /
    );
  });
  describe('model requests', () => {
    const catalog: ChatModelOption[] = [
      { id: 'claude-opus-5', name: 'Claude Opus 5', releaseDate: '2026-08-01', supportsTools: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', releaseDate: '2026-02-01', supportsTools: true },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', releaseDate: '2026-09-01', supportsTools: true },
      { id: 'claude-sonnet-5-1', name: 'Claude Sonnet 5.1', releaseDate: '2026-10-01', unavailable: 'Server down' },
      { id: 'claude-haiku-5', name: 'Claude Haiku 5', releaseDate: '2026-09-15', supportsTools: true },
      { id: 'gpt-6.1', name: 'GPT-6.1', releaseDate: '2026-07-01', supportsTools: true },
      { id: 'gpt-6.1-mini', name: 'GPT-6.1 mini', releaseDate: '2026-07-01', supportsTools: true },
    ];
    const open = {
      ...inheritancePolicy(),
      roles: { implementation: 'claude-sonnet-4-6', exploration: 'inherit', review: 'inherit' },
      allowedOverrides: ['claude-sonnet-5', 'claude-sonnet-5-1', 'claude-haiku-5', 'gpt-6.1', 'gpt-6.1-mini'],
    };

    it('resolves a family alias to the newest usable allowed model, never an unallowed or exact-id variant', () => {
      const ids = catalog.map(model => model.id);
      expect(resolveModelAlias('sonnet', ids, catalog)).toBe('claude-sonnet-5');
      expect(resolveModelAlias('Opus', ids, catalog)).toBe('claude-opus-5');
      expect(resolveModelAlias('gpt-6.1', ['gpt-6.1-mini'], catalog)).toBeNull();
      expect(resolveModelAlias('GPT 6.1', ['gpt-6.1-mini', 'gpt-6.10'], catalog)).toBe('gpt-6.1-mini');
      expect(resolveModelAlias('sonnet', ['claude-opus-5'], catalog)).toBeNull();
      expect(resolveModelAlias('claude-sonnet-5', ['claude-sonnet-5-1'], catalog)).toBeNull();
      expect(resolveModelAlias('son', ids, catalog)).toBeNull();
    });

    it('routes an alias through the allowlist and refuses with an actionable message', () => {
      expect(
        resolveWorkerModel('claude-opus-5', open, { role: 'implementation', requestedModelId: 'sonnet' }, catalog)
      ).toMatchObject({ effectiveModel: 'claude-sonnet-5', requestedModelId: 'sonnet', source: 'override' });
      expect(
        resolveWorkerModel('claude-opus-5', open, { role: 'review', requestedModelId: 'opus' }, catalog)
      ).toMatchObject({ effectiveModel: 'claude-opus-5' });
      expect(
        resolveWorkerModel(
          'claude-opus-5',
          open,
          { role: 'implementation', requestedModelId: 'claude-haiku-5' },
          catalog
        )
      ).toMatchObject({ effectiveModel: 'claude-haiku-5', source: 'override' });
      const closed = { ...open, allowedOverrides: [] };
      expect(() =>
        resolveWorkerModel('claude-opus-5', closed, { role: 'implementation', requestedModelId: 'opus' }, catalog)
      ).toThrow(
        "Model request refused: 'opus' is not an allowed override (allowed: none). Nothing was started. Omit requested_model_id to use the role default (claude-sonnet-4-6), or ask the user to allow it in orchestration settings."
      );
      expect(() =>
        resolveWorkerModel('claude-opus-5', open, { role: 'implementation', requestedModelId: 'opus' }, catalog)
      ).toThrow(/allowed: claude-sonnet-5, claude-sonnet-5-1, claude-haiku-5, gpt-6.1, gpt-6.1-mini\)/);
      expect(resolveWorkerModel('claude-opus-5', closed, { role: 'implementation' }, catalog)).toMatchObject({
        effectiveModel: 'claude-sonnet-4-6',
        source: 'role-policy',
      });
    });

    it('leaves requested_model_id out with no allowed override and lists the choices otherwise', () => {
      expect(modelRequestHint('claude-opus-5', inheritancePolicy())).toBeNull();
      expect(modelRequestHint('claude-opus-5', { ...open, allowedOverrides: ['claude-haiku-5'] })).toBe(
        'Optional; omit for the role default (implementation=claude-sonnet-4-6, exploration=claude-opus-5, review=claude-opus-5). Allowed: claude-haiku-5. A family name like sonnet picks the newest allowed match.'
      );
    });

    it('still refuses a hosted alias match for device-local work', () => {
      const local = [...catalog, { id: 'local:qwen3:8b', name: 'Qwen3 8B', supportsTools: true }];
      const selection = resolveWorkerModel(
        'local:qwen3:8b',
        { ...open, roles: { ...open.roles, implementation: 'inherit' } },
        { role: 'implementation', requestedModelId: 'sonnet' },
        local
      );
      expect(() => validateWorkerModel(selection.effectiveModel, local, { localOnly: true })).toThrow(
        /device-local work cannot use a hosted model/
      );
    });
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
  describe('criterion matching', () => {
    const criteria = ['Discarded messages leave list/count', 'Retry keeps the message order'];
    const multi: TaskContract = { ...contract, acceptanceCriteria: criteria };
    const check = (criterion: string, outcome: 'passed' | 'failed' | 'not-run' = 'passed') => ({
      criterion,
      command: 'pnpm test dlq',
      outcome,
      evidence: 'Observed in the focused run',
    });
    const report = (
      verification: ReturnType<typeof check>[],
      unmetCriteria: string[] = []
    ): Extract<WorkerTask['state'], { status: 'completed' }> => ({
      status: 'completed',
      accepted: false,
      changedPaths: [],
      verification,
      unmetCriteria,
      handoff: 'Done',
    });
    const withState = (state: WorkerTask['state']): WorkerTask => ({ ...task(), contract: multi, state });

    it('names the uncovered criteria when every check passed under other labels', () => {
      const labelled = withState(report([check('Targeted DLQ tests'), check('Relevant typecheck')]));
      expect(() => acceptTask(labelled, 'Looks fine')).toThrow(
        /No passed verification entry quotes these acceptance criteria:\n- "Discarded messages leave list\/count"\n- "Retry keeps the message order"/
      );
    });
    it('accepts exact and whitespace, case or trailing-punctuation variants, alongside extra checks', () => {
      expect(acceptTask(withState(report(criteria.map(c => check(c)))), 'Exact').state).toMatchObject({
        accepted: true,
      });
      const variants = report([
        check('  discarded   MESSAGES leave list/count.'),
        check('Retry keeps the message order!\n'),
        check('Relevant typecheck'),
      ]);
      expect(acceptTask(withState(variants), 'Variants').state).toMatchObject({ accepted: true });
    });
    it('does not match anything fuzzier than whitespace, case and trailing punctuation', () => {
      const near = withState(report([check('Discarded messages leave the list/count'), check(criteria[1])]));
      expect(() => acceptTask(near, 'Close enough')).toThrow(/- "Discarded messages leave list\/count"/);
    });
    it('still rejects a failed check or an unmet criterion and lists each', () => {
      const failed = withState(
        report([...criteria.map(c => check(c)), check('Lint', 'failed'), check('E2E', 'not-run')])
      );
      expect(() => acceptTask(failed, 'Ignore')).toThrow(
        /Checks that did not pass:\n- "Lint" \(failed\)\n- "E2E" \(not-run\)/
      );
      const failedCriterion = withState(report([check(criteria[0]), check(criteria[1], 'failed')]));
      expect(() => acceptTask(failedCriterion, 'Ignore')).toThrow(/quotes these acceptance criteria:\n- "Retry keeps/);
      const unmet = withState(
        report(
          criteria.map(c => check(c)),
          ['Edge case still open']
        )
      );
      expect(() => acceptTask(unmet, 'Ignore')).toThrow(/Unmet criteria reported:\n- "Edge case still open"/);
    });
    it('rejects a completed report that leaves a criterion unaccounted for', () => {
      const { accepted: _accepted, ...uncovered } = report([check('Targeted DLQ tests'), check(criteria[1])]);
      expect(() => assertReportCoversCriteria(multi, uncovered)).toThrow(
        /exact text.*Not covered:\n- "Discarded messages leave list\/count"$/s
      );
      const { accepted: _a, ...honest } = report([check(criteria[0], 'failed')], [`${criteria[1]}.`]);
      expect(() => assertReportCoversCriteria(multi, honest)).not.toThrow();
      const { accepted: _b, ...variant } = report([check(' DISCARDED messages leave list/count '), check(criteria[1])]);
      expect(() => assertReportCoversCriteria(multi, variant)).not.toThrow();
    });
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
