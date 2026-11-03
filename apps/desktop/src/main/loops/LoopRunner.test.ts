import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAutomaticOrigin, ChatSession, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import type { LoopStageGuards } from '@shared/loopRunner';
import { check, snapshot } from '../pr/prTestSupport';
import type { MachineSample } from './budget';
import { LoopPolicyStore } from './LoopPolicyStore';
import { LoopRunner, type LoopRunnerDeps } from './LoopRunner';
import { LeaseLost, type LoopRunnerApi, type RunnerClaim, type RunnerTicket } from './LoopRunnerClient';

const GB = 1024 ** 3;
const PR = 'https://github.com/example-org/widgets/pull/611';

const ticket = (id: string, loopId = 'loop-1'): RunnerTicket => ({
  ticketId: id,
  title: `Ticket ${id}`,
  loopId,
  loopName: 'Docs loop',
  stage: 'build',
});

function harness(options: { guards?: LoopStageGuards; mergePolicy?: 'review' | 'green-ci' | 'never' } = {}) {
  const sample: MachineSample = {
    cores: 16,
    freeBytes: 16 * GB,
    swapUsedBytes: 0,
    loadRatio: 0.1,
    diskFreeBytes: 200 * GB,
    onBattery: false,
    idleSeconds: 600,
  };
  const tickets: RunnerTicket[] = [ticket('t1')];
  const completed: { runId: string; outcome: Record<string, unknown> }[] = [];
  const progress: unknown[][] = [];
  let runs = 0;
  const client: LoopRunnerApi = {
    listTickets: vi.fn(async () => tickets),
    claim: vi.fn(async (ticketId: string): Promise<RunnerClaim> => {
      runs++;
      return {
        ticket: tickets.find(entry => entry.ticketId === ticketId) as RunnerTicket,
        runId: `run-${runs}`,
        leaseExpiresAt: '',
        prompt: 'Work the ticket.',
        stage: { mergePolicy: options.mergePolicy ?? 'review', ...(options.guards ? { guards: options.guards } : {}) },
      };
    }),
    heartbeat: vi.fn(async () => undefined),
    progress: vi.fn(async (_runId: string, frames: unknown[]) => void progress.push(frames)),
    complete: vi.fn(async (runId: string, outcome: Record<string, unknown>) => void completed.push({ runId, outcome })),
    presence: vi.fn(async () => undefined),
  };

  // A user's own session lives alongside the runner's; nothing may ever touch it.
  const runOf = new Map<string, string>();
  const sessions = new Map<string, ChatSession>();
  sessions.set('user-session', { id: 'user-session' } as ChatSession);
  let created = 0;
  const chat = {
    createCodeSession: vi.fn(async () => {
      const id = `s${++created}`;
      sessions.set(id, {
        id,
        project: {
          directory: '/repo',
          name: 'repo',
          branch: 'main',
          workspace: true,
          workspaceBranch: `b4m/${id}`,
          workingDirectory: `/repo/.b4m/worktrees/${id}`,
          contextDirectories: [],
        },
      } as unknown as ChatSession);
      return { ok: true as const, session: { id } as never };
    }),
    setApprovalMode: vi.fn(async () => null),
    startAutomaticTurn: vi.fn(async (sessionId: string, _text: string, automatic: ChatAutomaticOrigin) => {
      if (automatic.kind === 'loop-runner') runOf.set(sessionId, automatic.runId);
      return { ok: true as const };
    }),
    stop: vi.fn(),
    isSessionBusy: vi.fn(() => false),
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    deleteSession: vi.fn(async (id: string) => {
      sessions.delete(id);
      runOf.delete(id);
    }),
    removeWorktrees: vi.fn(async () => []),
    loopRunOf: (id: string) => runOf.get(id),
    loopRunSessions: (runId: string) => [...runOf].filter(([, run]) => run === runId).map(([id]) => id),
  };

  const file = { text: null as string | null };
  const store = new LoopPolicyStore({ read: async () => file.text, write: async text => void (file.text = text) });
  const killed: string[] = [];
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
  let labels: string[] = [];
  let pr = snapshot({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: [check('Build', 'pass')] });
  const github = {
    snapshot: vi.fn(async () => pr),
    merge: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => 1),
    findOpenForBranch: vi.fn(async (_cwd: string, _branch: string): Promise<string | null> => null),
  };
  let deployConclusion = 'success';
  const gh = vi.fn(async (args: readonly string[]) => {
    if (args.includes('labels')) return JSON.stringify({ labels: labels.map(name => ({ name })) });
    if (args.includes('mergeCommit')) return JSON.stringify({ mergeCommit: { oid: 'merge-sha' } });
    if (args[0] === 'run') return JSON.stringify([{ status: 'completed', conclusion: deployConclusion }]);
    return '{}';
  });
  let smokeStatus = 200;
  let clock = 1_000_000;
  const deps: LoopRunnerDeps = {
    client,
    chat,
    killSessionProcesses: id => void killed.push(id),
    store,
    environment: () => ({ key: 'hosted', url: 'https://app.example.com' }),
    sample: async () => ({ ...sample }),
    gh,
    github,
    powerSaveBlocker: blocker,
    smoke: { fetch: async () => ({ status: smokeStatus }), run: async () => undefined },
    focused: () => false,
    onChange: () => undefined,
    logger: { warn: () => undefined },
    now: () => clock,
    sleep: async ms => void (clock += ms),
  };
  const runner = new LoopRunner(deps);
  const approve = (loopId = 'loop-1') =>
    store.approve('hosted', {
      loopId,
      loopName: 'Docs loop',
      approvalMode: 'auto',
      directory: '/repo',
      approvedAt: 'now',
    });
  const emit = (event: ChatStreamEvent) => runner.observe(event);
  const done = (sessionId = 's1', content = 'All done.') => emit({ type: 'done', sessionId, messageId: 'm', content });
  const settled = () => vi.waitFor(() => expect(completed.length).toBeGreaterThan(0));

  return {
    runner,
    client,
    chat,
    store,
    github,
    gh,
    blocker,
    killed,
    completed,
    progress,
    tickets,
    sample,
    sessions,
    approve,
    emit,
    done,
    settled,
    setLabels: (next: string[]) => void (labels = next),
    setPr: (next: typeof pr) => void (pr = next),
    setDeploy: (next: string) => void (deployConclusion = next),
    setSmoke: (next: number) => void (smokeStatus = next),
  };
}

let h: ReturnType<typeof harness>;
afterEach(() => {
  h?.runner.dispose();
  vi.useRealTimers();
});

describe('LoopRunner claiming', () => {
  beforeEach(() => {
    h = harness();
  });

  it('never claims an unapproved loop, lists it for approval, and claims once approved', async () => {
    await h.runner.tick();
    expect(h.client.claim).not.toHaveBeenCalled();
    expect(h.runner.state().pendingApprovals).toEqual([{ loopId: 'loop-1', loopName: 'Docs loop' }]);

    await h.approve();
    await h.runner.tick();
    expect(h.client.claim).toHaveBeenCalledWith('t1');
    expect(h.chat.createCodeSession).toHaveBeenCalledWith({ directory: '/repo', workspace: true });
    expect(h.chat.setApprovalMode).toHaveBeenCalledWith('s1', 'auto');
    expect(h.chat.startAutomaticTurn).toHaveBeenCalledWith('s1', 'Work the ticket.', {
      kind: 'loop-runner',
      loopId: 'loop-1',
      ticketId: 't1',
      runId: 'run-1',
      summary: 'Ticket t1',
    });
    expect(h.runner.state().pendingApprovals).toEqual([]);
  });

  it('stops claiming a revoked loop', async () => {
    await h.approve();
    await h.store.revoke('hosted', 'loop-1');
    await h.runner.tick();
    expect(h.client.claim).not.toHaveBeenCalled();
  });

  it('holds a claim the budget does not admit, and says why', async () => {
    await h.approve();
    h.sample.onBattery = true;
    await h.runner.tick();
    expect(h.client.claim).not.toHaveBeenCalled();
    expect(h.runner.state().waitingReason).toBe('on battery');
    expect(h.client.presence).toHaveBeenCalledWith({ lanesBusy: 0, lanesFree: 4, waitingReason: 'on battery' });
  });
});

describe('LoopRunner runs', () => {
  beforeEach(async () => {
    h = harness();
    await h.approve();
  });

  it('streams progress, advances on done, holds the power blocker only while busy, and removes the worktree', async () => {
    await h.runner.tick();
    expect(h.blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    h.emit({ type: 'delta', sessionId: 's1', messageId: 'm', text: 'Working' });
    h.done();
    await h.settled();
    expect(h.progress).toEqual([[{ type: 'text', text: 'Working' }]]);
    expect(h.completed).toEqual([
      { runId: 'run-1', outcome: { outcome: 'advanced', answer: 'All done.', durationMs: expect.any(Number) } },
    ]);
    expect(h.blocker.stop).toHaveBeenCalledWith(7);
    await vi.waitFor(() => expect(h.chat.deleteSession).toHaveBeenCalledWith('s1', true));
    expect(await h.store.worktrees()).toEqual([]);
  });

  it('keeps the worktree while its PR is open', async () => {
    h.github.findOpenForBranch.mockResolvedValue(PR);
    await h.runner.tick();
    h.done();
    await h.settled();
    await vi.waitFor(async () => expect(await h.store.worktrees()).toHaveLength(1));
    expect(h.chat.deleteSession).not.toHaveBeenCalled();
  });

  it('blocks the ticket with the unanswered card as the reason', async () => {
    await h.runner.tick();
    const call: ChatToolCall = {
      id: 'c1',
      name: 'bash_execute',
      input: { command: 'rm -rf build' },
      status: 'awaiting-approval',
      approvalDetail: 'rm -rf build',
    };
    h.emit({ type: 'tool-start', sessionId: 's1', messageId: 'm', call });
    h.runner.unattended('s1');
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'blocked', reason: 'Needs approval: rm -rf build' });
    expect(h.chat.stop).toHaveBeenCalledWith('s1');
    // The turn's own 'done' after the stop is not a second outcome.
    h.done();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.completed).toHaveLength(1);
  });

  it('turns an ask_user question into the block reason', async () => {
    await h.runner.tick();
    h.emit({
      type: 'tool-start',
      sessionId: 's1',
      messageId: 'm',
      call: {
        id: 'c1',
        name: 'ask_user',
        input: { questions: [{ question: 'Which env?' }] },
        status: 'awaiting-approval',
      },
    });
    h.runner.unattended('s1');
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'blocked', reason: 'Question: Which env?' });
  });

  it('fails the ticket on a turn error', async () => {
    await h.runner.tick();
    h.emit({ type: 'error', sessionId: 's1', messageId: 'm', message: 'model unavailable' });
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'failed', reason: 'model unavailable' });
  });

  it('drops the work without reporting when the lease is lost', async () => {
    vi.useFakeTimers();
    vi.mocked(h.client.progress).mockRejectedValue(new LeaseLost('run-1'));
    await h.runner.tick();
    h.emit({ type: 'delta', sessionId: 's1', messageId: 'm', text: 'x' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.chat.stop).toHaveBeenCalledWith('s1');
    expect(h.runner.busy).toBe(0);
    expect(h.client.complete).not.toHaveBeenCalled();
  });

  it('below the hard disk floor stops only its own sessions and hands the tickets back', async () => {
    await h.runner.tick();
    h.sample.diskFreeBytes = 5 * GB;
    await h.runner.tick();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'released' });
    expect(h.chat.stop.mock.calls.flat()).toEqual(['s1']);
    expect(h.killed).toEqual(['s1']);
    expect(h.chat.stop).not.toHaveBeenCalledWith('user-session');
    expect(h.client.claim).toHaveBeenCalledTimes(1);
  });

  it('releases everything on quit', async () => {
    await h.runner.tick();
    await h.runner.releaseAll();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'released' });
  });
});

describe('LoopRunner merges', () => {
  async function started(options: Parameters<typeof harness>[0] = {}) {
    h = harness(options);
    await h.approve();
    await h.runner.tick();
  }

  it('review merges an approved green PR with --match-head-commit', async () => {
    await started();
    expect(await h.runner.merge('s1', PR)).toMatch(/Merged/);
    expect(h.github.merge).toHaveBeenCalledWith(expect.objectContaining({ number: 611 }), 'squash', 'sha-1');
  });

  it('green-ci merges without approval; review does not', async () => {
    await started({ mergePolicy: 'green-ci' });
    h.setPr(snapshot({ mergeStateStatus: 'CLEAN', checks: [check('Build', 'pass')] }));
    expect(await h.runner.merge('s1', PR)).toMatch(/Merged/);

    await started({ mergePolicy: 'review' });
    h.setPr(snapshot({ mergeStateStatus: 'CLEAN', checks: [check('Build', 'pass')] }));
    await expect(h.runner.merge('s1', PR)).rejects.toThrow(/approving review/);
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'blocked' });
  });

  it('never blocks the ticket awaiting a human merge', async () => {
    await started({ mergePolicy: 'never' });
    await expect(h.runner.merge('s1', PR)).rejects.toThrow(/awaiting human merge/);
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'blocked', reason: 'awaiting human merge' });
    expect(h.github.merge).not.toHaveBeenCalled();
  });

  it('refuses a held PR in every mode', async () => {
    await started({ mergePolicy: 'green-ci' });
    h.setLabels(['Needs-Approval']);
    await expect(h.runner.merge('s1', PR)).rejects.toThrow(/Needs-Approval/);
    expect(h.github.merge).not.toHaveBeenCalled();
  });

  it("blocks with GitHub's reason when GitHub refuses the merge", async () => {
    await started();
    h.github.merge.mockRejectedValue(new Error('Base branch was modified'));
    await expect(h.runner.merge('s1', PR)).rejects.toThrow(/Base branch was modified/);
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ reason: 'GitHub refused the merge: Base branch was modified' });
  });

  it('blocks on a failed deploy, then on a failed smoke, and advances when both pass', async () => {
    const guards = { deployWorkflow: 'deploy.yml', smoke: { url: 'https://app.example.com/health' } };
    await started({ guards });
    h.setDeploy('failure');
    await h.runner.merge('s1', PR);
    h.done();
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({
      outcome: 'blocked',
      reason: expect.stringMatching(/deploy did not reach prod/),
    });

    await started({ guards });
    h.setSmoke(500);
    await h.runner.merge('s1', PR);
    h.done();
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({
      outcome: 'blocked',
      reason: expect.stringMatching(/smoke check failed/),
    });

    await started({ guards });
    await h.runner.merge('s1', PR);
    h.done();
    await h.settled();
    expect(h.completed[0].outcome).toMatchObject({ outcome: 'advanced' });
  });
});

describe('LoopRunner worktree collection', () => {
  it('removes only recorded worktrees: finished without a PR, or past the age limit', async () => {
    h = harness();
    const base = { directory: '/repo', ticketId: 't' };
    await h.store.recordWorktree({
      ...base,
      sessionId: 'a',
      path: '/w/a',
      branch: 'b4m/a',
      createdAt: new Date(1_000_000).toISOString(),
      finishedAt: 'x',
    });
    await h.store.recordWorktree({
      ...base,
      sessionId: 'b',
      path: '/w/b',
      branch: 'b4m/b',
      createdAt: new Date(1_000_000).toISOString(),
      finishedAt: 'x',
    });
    await h.store.recordWorktree({
      ...base,
      sessionId: 'c',
      path: '/w/c',
      branch: 'b4m/c',
      createdAt: new Date(0 - 8 * 86_400_000).toISOString(),
    });
    h.github.findOpenForBranch.mockImplementation(async (_cwd: string, branch: string) =>
      branch === 'b4m/b' ? PR : null
    );
    await h.runner.collectWorktrees();
    expect(h.chat.removeWorktrees.mock.calls).toEqual([
      ['/repo', ['/w/a']],
      ['/repo', ['/w/c']],
    ]);
    expect((await h.store.worktrees()).map(entry => entry.sessionId)).toEqual(['b']);
    expect(h.chat.deleteSession).not.toHaveBeenCalledWith('user-session', expect.anything());
  });
});
