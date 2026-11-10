import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { inheritancePolicy } from '@shared/orchestration';
import { SessionStore } from './SessionStore';
import type { SessionScope } from './sessionScope';

const contract = {
  version: 1 as const,
  outcome: 'Bounded task',
  rationale: 'Focused scope',
  role: 'implementation' as const,
  paths: [],
  contextReferences: [],
  ownedChanges: [],
  coordinationConstraints: [],
  nonGoals: [],
  acceptanceCriteria: ['Observed result'],
  verification: [],
  assumptions: [],
  escalationConditions: [],
};

it('isolates future defaults by account/environment, preserving root snapshots and legacy sessions across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-role-policy-'));
  let scope: SessionScope | null = { environmentUrl: 'https://example.test', accountId: 'first' };
  const store = new SessionStore(directory, 'planner', 'launch-one', () => scope);
  const policy = {
    ...inheritancePolicy(),
    roles: { implementation: 'worker', exploration: 'inherit', review: 'inherit' },
  };
  const legacy = await store.create();
  await store.setRolePolicy(policy);
  const root = await store.create('planner', {
    orchestrationPolicy: { rootSessionId: legacy.id, rootRunId: 'run-one', policy },
  });
  await store.setRolePolicy(inheritancePolicy());
  expect((await store.get(root.id))?.orchestrationPolicy?.policy).toEqual(policy);
  scope = { environmentUrl: 'https://example.test', accountId: 'second' };
  expect(await store.getRolePolicy()).toEqual(inheritancePolicy());
  expect(await store.get(root.id)).toBeNull();
  await store.setRolePolicy(policy);
  scope = { environmentUrl: 'https://other.test', accountId: 'second' };
  expect(await store.getRolePolicy()).toEqual(inheritancePolicy());
  scope = { environmentUrl: 'https://example.test', accountId: 'second' };
  expect(await new SessionStore(directory, 'planner', 'launch-two', () => scope).getRolePolicy()).toEqual(policy);
  scope = { environmentUrl: 'https://example.test', accountId: 'first' };
  const restarted = new SessionStore(directory, 'planner', 'launch-two', () => scope);
  expect((await restarted.get(root.id))?.orchestrationPolicy?.rootRunId).toBe('run-one');
  expect((await restarted.get(legacy.id))?.workerTask).toBeUndefined();
  expect((await restarted.get(legacy.id))?.model).toBe('planner');
  scope = null;
  await expect(store.getRolePolicy()).rejects.toThrow(/account/);
});

it('retains pending decisions, resolved decision IDs, attempt lineage and accepted evidence through restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-task-restart-'));
  const store = new SessionStore(directory, 'planner', 'launch-one');
  const root = await store.create();
  const child = await store.create('worker', {
    origin: { parentSessionId: root.id, depth: 1, seedPrompt: 'Brief' },
    orchestrationPolicy: { rootSessionId: root.id, rootRunId: 'run-one', policy: inheritancePolicy() },
    workerSelection: {
      role: 'implementation',
      requestedModelId: 'worker',
      effectiveModel: 'worker',
      source: 'override',
      rootRunId: 'run-one',
    },
    workerTask: {
      version: 1,
      contract,
      automaticUpgrades: 0,
      resolvedDecisions: ['previous-decision'],
      attempts: [{ id: 'attempt-one', model: 'worker', startedAt: '2026-11-07', trigger: 'initial' }],
      state: {
        status: 'escalation-requested',
        decisionId: 'pending-decision',
        reason: 'Assumption disproven',
        evidence: ['Observed incompatible interface'],
        requestedModelId: 'reviewer',
      },
    },
  });
  const restarted = new SessionStore(directory, 'planner', 'launch-two');
  expect((await restarted.get(child.id))?.workerTask).toEqual(child.workerTask);
  expect((await restarted.get(child.id))?.workerSelection).toEqual(child.workerSelection);
  await restarted.updateWorkerTask(child.id, task => ({
    ...task,
    state: {
      status: 'completed',
      accepted: true,
      assessment: 'Reviewed observation',
      changedPaths: [],
      verification: [
        { criterion: 'Observed result', command: 'inspect', outcome: 'passed', evidence: 'Observed expected behavior' },
      ],
      unmetCriteria: [],
      handoff: 'Ready',
    },
  }));
  const restored = await new SessionStore(directory, 'planner', 'launch-three').get(child.id);
  expect(restored?.workerTask?.state).toMatchObject({
    status: 'completed',
    accepted: true,
    assessment: 'Reviewed observation',
  });
  expect(restored?.workerTask?.attempts).toHaveLength(1);
  expect(restored?.workerTask?.resolvedDecisions).toEqual(['previous-decision']);
  await restarted.updateWorkerTask(child.id, task => ({
    ...task,
    state: { status: 'canceled', reason: 'Canceled by user' },
  }));
  await expect(restarted.setWorkerModel(child.id, 'reviewer', restarted.scopeKey())).rejects.toThrow(/Canceled/);
  expect((await restarted.get(child.id))?.model).toBe('worker');
});

it('keeps the initial and newest 31 attempts when another attempt is appended', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-task-attempts-'));
  const store = new SessionStore(directory, 'worker');
  const attempts = Array.from({ length: 32 }, (_, index) => ({
    id: `attempt-${index}`,
    model: 'worker',
    startedAt: '2026-11-07',
    trigger: 'revision' as const,
  }));
  const child = await store.create('worker', {
    workerTask: {
      version: 1,
      contract,
      automaticUpgrades: 0,
      resolvedDecisions: [],
      attempts,
      state: { status: 'queued' },
    },
  });
  const latest = { ...attempts[31], id: 'attempt-32' };
  const updated = await store.updateWorkerTask(child.id, task => ({
    ...task,
    attempts: [...task.attempts, latest],
  }));
  const expected = [attempts[0], ...attempts.slice(2), latest];
  expect(updated?.workerTask?.attempts).toEqual(expected);
  expect((await new SessionStore(directory, 'worker').get(child.id))?.workerTask?.attempts).toEqual(expected);
});

it.each(['orchestrationPolicy', 'workerSelection', 'workerTask'] as const)(
  'keeps a session with malformed %s visible and readable',
  async field => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-task-malformed-'));
    const store = new SessionStore(directory, 'worker');
    const child = await store.create();
    const session = await store.get(child.id);
    await writeFile(join(directory, `${child.id}.json`), JSON.stringify({ ...session, [field]: { version: 99 } }));
    const restarted = new SessionStore(directory, 'worker');
    expect((await restarted.list()).map(entry => entry.id)).toContain(child.id);
    expect((await restarted.get(child.id))?.[field]).toBeUndefined();
  }
);

it.each(['{', '{"version":99}'])('falls back to inheritance for malformed saved role policy %s', async contents => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-role-policy-malformed-'));
  const store = new SessionStore(directory, 'worker');
  await store.setRolePolicy(inheritancePolicy());
  await writeFile(join(directory, '.role-policy'), contents);
  expect(await store.getRolePolicy()).toEqual(inheritancePolicy());
});

it('drops a root policy snapshot when orchestrate expires on restart, keeping a worker policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-policy-reseed-'));
  const first = new SessionStore(directory, 'planner', 'launch-one');
  const policy = inheritancePolicy();
  const root = await first.create('planner', {
    orchestrationPolicy: { rootSessionId: 'root', rootRunId: 'run-one', policy },
  });
  await first.setOrchestrate(root.id, true);
  const child = await first.create('worker', {
    origin: { parentSessionId: root.id, depth: 1, seedPrompt: 'Brief' },
    orchestrationPolicy: { rootSessionId: root.id, rootRunId: 'run-one', policy },
  });
  const same = new SessionStore(directory, 'planner', 'launch-one');
  expect((await same.get(root.id))?.orchestrationPolicy?.rootRunId).toBe('run-one');
  const restarted = new SessionStore(directory, 'planner', 'launch-two');
  const reloaded = await restarted.get(root.id);
  expect(reloaded?.orchestrate).toBeUndefined();
  expect(reloaded?.orchestrationPolicy).toBeUndefined();
  expect((await restarted.get(child.id))?.orchestrationPolicy?.rootRunId).toBe('run-one');
});

it('warns without stored values for a malformed workerTask and stays silent for a valid session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-parse-warn-'));
  const store = new SessionStore(directory, 'worker');
  const child = await store.create();
  const session = await store.get(child.id);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await new SessionStore(directory, 'worker').get(child.id);
    expect(warn).not.toHaveBeenCalled();
    await writeFile(
      join(directory, `${child.id}.json`),
      JSON.stringify({ ...session, workerTask: { version: 99, secret: 'stored-value' } })
    );
    await new SessionStore(directory, 'worker').get(child.id);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('workerTask');
    expect(warn.mock.calls[0][0]).toContain(child.id);
    expect(warn.mock.calls[0][0]).not.toContain('stored-value');
  } finally {
    warn.mockRestore();
  }
});

it.each([32, 31])('keeps the newest resolved decision when a task holding %i takes one more', async held => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-task-decisions-'));
  const store = new SessionStore(directory, 'worker');
  const resolvedDecisions = Array.from({ length: held }, (_, index) => `decision-${index}`);
  const child = await store.create('worker', {
    workerTask: {
      version: 1,
      contract,
      automaticUpgrades: 0,
      resolvedDecisions,
      attempts: [{ id: 'attempt-0', model: 'worker', startedAt: '2026-11-07', trigger: 'initial' as const }],
      state: { status: 'queued' },
    },
  });
  const updated = await store.updateWorkerTask(child.id, task => ({
    ...task,
    resolvedDecisions: [...task.resolvedDecisions, 'decision-new'],
  }));
  const kept = updated?.workerTask?.resolvedDecisions;
  expect(kept).toHaveLength(32);
  expect(kept?.at(-1)).toBe('decision-new');
  expect(kept?.includes('decision-0')).toBe(held === 31);
});

it('loads a session stored before run attribution, then keeps a server run id through restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-run-attribution-'));
  const store = new SessionStore(directory, 'worker');
  const child = await store.create();
  const session = await store.get(child.id);
  const legacyPolicy = { rootSessionId: 'root', rootRunId: 'run-one', policy: inheritancePolicy() };
  const legacyRound = { text: 'Done', toolCallIds: [], usage: { creditsUsed: 3 } };
  await writeFile(
    join(directory, `${child.id}.json`),
    JSON.stringify({
      ...session,
      origin: { parentSessionId: 'root', depth: 1, seedPrompt: 'Brief' },
      orchestrationPolicy: legacyPolicy,
      messages: [{ id: 'm1', role: 'assistant', content: 'Done', createdAt: '2026-01-01', rounds: [legacyRound] }],
    })
  );

  const restarted = new SessionStore(directory, 'worker');
  const loaded = await restarted.get(child.id);
  expect(loaded?.orchestrationPolicy).toEqual(legacyPolicy);
  expect(loaded?.messages[0].rounds).toEqual([legacyRound]);

  expect(await restarted.setServerRunId(child.id, 'another-run', 'server-run')).toBeNull();
  await restarted.setServerRunId(child.id, 'run-one', 'server-run');
  expect((await new SessionStore(directory, 'worker').get(child.id))?.orchestrationPolicy?.serverRunId).toBe(
    'server-run'
  );
  await restarted.setServerRunId(child.id, 'run-one', undefined);
  expect((await new SessionStore(directory, 'worker').get(child.id))?.orchestrationPolicy).toEqual(legacyPolicy);
});
