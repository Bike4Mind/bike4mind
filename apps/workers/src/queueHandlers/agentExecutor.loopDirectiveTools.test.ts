import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyToolPermission, LOOP_DIRECTIVE_TOOL_NAMES, LOOP_OVERSEER_TOOL_NAMES } from '@bike4mind/common';

const loops = vi.hoisted(() => ({
  findByIdAndUserId: vi.fn(),
  updateForUser: vi.fn(),
  endBackoff: vi.fn().mockResolvedValue(undefined),
  makeDueNow: vi.fn().mockResolvedValue(true),
}));
const directives = vi.hoisted(() => ({
  create: vi.fn(),
  countByExecution: vi.fn(),
  countActionsSince: vi.fn(),
  findByIdForUser: vi.fn(),
  transition: vi.fn(),
  listToLoop: vi.fn(),
}));
const executions = vi.hoisted(() => ({ sumCreditsByLoop: vi.fn(), listRecentForLoop: vi.fn() }));
const items = vi.hoisted(() => ({ listForUser: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  loopRepository: loops,
  loopDirectiveRepository: directives,
  agentExecutionRepository: executions,
  workItemRepository: items,
  adminSettingsRepository: { getSettingsValue: async () => true },
}));
const dispatch = vi.hoisted(() => ({ requestLoopDispatch: vi.fn(), pushLoopChanged: vi.fn() }));
vi.mock('@server/utils/loopDispatch', () => dispatch);

import {
  buildLoopDirectiveTools,
  MAX_DIRECTIVES_PER_RUN,
  resolveLoopDirectiveTools,
} from './agentExecutor.loopDirectiveTools';

const OVERSEER = '507f1f77bcf86cd799439011';
const WORKER = '507f1f77bcf86cd799439012';
const UNWATCHED = '507f1f77bcf86cd799439013';
const FOREIGN = '507f1f77bcf86cd799439014';

const loopDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  userId: 'u1',
  name: `loop-${id.slice(-2)}`,
  goal: 'always write tests',
  tools: ['web_search'],
  status: 'live',
  sessionId: `s-${id}`,
  intervalMinutes: 15,
  budgetCreditsPerDay: 10,
  consecutiveFailures: 0,
  memory: { notes: 'n'.repeat(2000), nextAction: 'next' },
  ...overrides,
});

const directive = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  loopId: WORKER,
  userId: 'u1',
  fromLoopId: OVERSEER,
  fromLoopName: 'Overseer',
  executionId: 'x-overseer',
  instruction: 'Stop writing tests',
  reason: 'Slow',
  state: 'open',
  replies: [],
  ...overrides,
});

const run = (tools: ReturnType<typeof buildLoopDirectiveTools>, name: string, params: unknown) =>
  tools[name].implementation({ userId: 'u1' } as never).toolFn(params) as Promise<string>;

let oversees: string[] = [WORKER, FOREIGN];
let workerOverrides: Record<string, unknown> = {};

beforeEach(() => {
  vi.clearAllMocks();
  oversees = [WORKER, FOREIGN];
  workerOverrides = {};
  loops.findByIdAndUserId.mockImplementation(async (id: string, userId: string) => {
    if (userId !== 'u1') return null;
    if (id === OVERSEER) return loopDoc(OVERSEER, { name: 'Overseer', oversees });
    if (id === WORKER) return loopDoc(id, workerOverrides);
    if (id === UNWATCHED) return loopDoc(id);
    return null;
  });
  directives.countByExecution.mockResolvedValue(0);
  directives.countActionsSince.mockResolvedValue(0);
  loops.updateForUser.mockImplementation(async (id: string, _u: string, patch: Record<string, unknown>) => ({
    ...loopDoc(id, workerOverrides),
    ...patch,
  }));
  directives.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: 'd-new', ...doc }));
  directives.transition.mockImplementation(async (id, _u, _from, state, reply) =>
    directive({ id, state, replies: [reply] })
  );
  directives.listToLoop.mockResolvedValue([
    directive({
      state: 'pushed_back',
      replies: [{ by: 'worker', outcome: 'pushed_back', note: 'no', at: new Date() }],
    }),
  ]);
  executions.sumCreditsByLoop.mockImplementation(async (_ids: string[], _sessions: string[], since?: Date) => ({
    [WORKER]: since ? 7 : 42,
  }));
  executions.listRecentForLoop.mockResolvedValue([{ id: 'r1', status: 'completed', totalCreditsUsed: 3 }]);
  items.listForUser.mockResolvedValue({
    data: [
      { id: 't1', title: 'A', stage: 'todo', status: 'open' },
      { id: 't2', title: 'B', stage: 'todo', status: 'blocked', statusReason: 'needs key' },
      { id: 't3', title: 'C', stage: 'doing', status: 'in_progress' },
    ],
    hasMore: false,
  });
});

describe('resolveLoopDirectiveTools', () => {
  const resolve = (loopId: string | undefined, loopsEnabled = true) =>
    resolveLoopDirectiveTools({ loopId, loopsEnabled, userId: 'u1', executionId: 'x1' });

  it('offers loop_directive_respond on every loop run, and the overseer tools only with oversees', async () => {
    const overseer = await resolve(OVERSEER);
    expect(overseer.loopDirectiveEnabledTools).toEqual([...LOOP_DIRECTIVE_TOOL_NAMES, ...LOOP_OVERSEER_TOOL_NAMES]);
    expect(Object.keys(overseer.loopDirectiveExternalTools).sort()).toEqual(
      [...LOOP_DIRECTIVE_TOOL_NAMES, ...LOOP_OVERSEER_TOOL_NAMES].sort()
    );

    const worker = await resolve(WORKER);
    expect(worker.loopDirectiveEnabledTools).toEqual(LOOP_DIRECTIVE_TOOL_NAMES);
    expect(Object.keys(worker.loopDirectiveExternalTools)).toEqual([...LOOP_DIRECTIVE_TOOL_NAMES]);

    oversees = [];
    expect((await resolve(OVERSEER)).loopDirectiveEnabledTools).toEqual(LOOP_DIRECTIVE_TOOL_NAMES);
  });

  it('offers nothing off a loop run or with EnableLoops off', async () => {
    for (const off of [await resolve(undefined), await resolve(OVERSEER, false)]) {
      expect(off).toEqual({ loopDirectiveEnabledTools: [], loopDirectiveExternalTools: {} });
    }
  });

  it('every tool is allowed on a headless loop run, whose approvedTools carry the names', () => {
    const approved = [...LOOP_DIRECTIVE_TOOL_NAMES, ...LOOP_OVERSEER_TOOL_NAMES];
    for (const name of approved) expect(classifyToolPermission(name, approved, [])).toBe('allowed');
    expect(classifyToolPermission('loop_directive_issue', [], [])).toBe('needs_approval');
  });
});

describe('loop_directive_issue', () => {
  const overseerTools = (executionId = 'x1') =>
    buildLoopDirectiveTools({ userId: 'u1', loopId: OVERSEER, executionId });
  const issue = (tools: ReturnType<typeof buildLoopDirectiveTools>, params: Record<string, unknown> = {}) =>
    run(tools, 'loop_directive_issue', {
      loopId: WORKER,
      instruction: ' Stop writing tests ',
      reason: 'Slow',
      ...params,
    });

  it('creates an open directive to a watched loop, without touching the worker loop', async () => {
    expect(JSON.parse(await issue(overseerTools()))).toEqual({ id: 'd-new', loopId: WORKER, state: 'open' });
    expect(directives.create).toHaveBeenCalledWith({
      loopId: WORKER,
      userId: 'u1',
      fromLoopId: OVERSEER,
      fromLoopName: 'Overseer',
      executionId: 'x1',
      instruction: 'Stop writing tests',
      reason: 'Slow',
      state: 'open',
      replies: [],
    });
    // The worker's goal, tools and status have no write path from here; only an idle back-off ends.
    expect(loops.updateForUser).not.toHaveBeenCalled();
    expect(loops.endBackoff).toHaveBeenCalledWith(WORKER, expect.any(Date));
  });

  it.each([
    ['a loop it does not oversee', UNWATCHED],
    ["another user's loop, even when listed in oversees", FOREIGN],
    ['a missing id', 'nope'],
  ])('refuses %s as "loop not found" and writes nothing', async (_label, target) => {
    expect(await issue(overseerTools(), { loopId: target })).toBe('Error: loop not found');
    expect(directives.create).not.toHaveBeenCalled();
  });

  it('caps the instruction and reason, and refuses a non-string target', async () => {
    await issue(overseerTools(), { instruction: 'i'.repeat(2500), reason: 'r'.repeat(1500) });
    expect(directives.create).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: 'i'.repeat(2000), reason: 'r'.repeat(1000) })
    );
    expect(await issue(overseerTools(), { loopId: 42 })).toMatch(/^Error/);
    expect(directives.create).toHaveBeenCalledTimes(1);
  });

  it('re-reads oversees per call, so a loop the owner just removed is refused', async () => {
    const tools = overseerTools();
    oversees = [];
    expect(await issue(tools)).toBe('Error: loop not found');
  });

  it('requires an instruction and a reason', async () => {
    expect(await issue(overseerTools(), { instruction: '  ' })).toBe('Error: instruction is required');
    expect(await issue(overseerTools(), { reason: undefined })).toBe('Error: reason is required');
    expect(directives.create).not.toHaveBeenCalled();
  });

  it('refuses the 6th directive of a run, counted across tool-set builds with the same executionId', async () => {
    let stored = 0;
    directives.countByExecution.mockImplementation(async () => stored);
    directives.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: `d${++stored}`, ...doc }));

    const first = overseerTools('x-run');
    for (let i = 0; i < 3; i++) expect(await issue(first)).not.toMatch(/^Error/);
    // A continuation Lambda rebuilds the tools for the same run.
    const continuation = overseerTools('x-run');
    for (let i = 0; i < 2; i++) expect(await issue(continuation)).not.toMatch(/^Error/);
    expect(await issue(continuation)).toBe(`Error: at most ${MAX_DIRECTIVES_PER_RUN} directives can be issued per run`);
    expect(directives.create).toHaveBeenCalledTimes(MAX_DIRECTIVES_PER_RUN);
    expect(directives.countByExecution).toHaveBeenCalledWith('x-run');
  });
});

describe('loop_oversee_status', () => {
  const tools = () => buildLoopDirectiveTools({ userId: 'u1', loopId: OVERSEER, executionId: 'x1' });

  it('returns status, tickets by stage, recent runs, spend and directive threads for a watched loop', async () => {
    const { loops: result } = JSON.parse(await run(tools(), 'loop_oversee_status', { loopId: WORKER }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      loopId: WORKER,
      status: 'live',
      intervalMinutes: 15,
      creditsUsed: 42,
      creditsToday: 7,
      budgetCreditsPerDay: 10,
      ticketCounts: { todo: { open: 1, blocked: 1 }, doing: { in_progress: 1 } },
      blockedTickets: [{ id: 't2', statusReason: 'needs key' }],
      recentRuns: [{ id: 'r1', status: 'completed' }],
      recentDirectives: [{ id: 'd1', state: 'pushed_back', replies: [{ by: 'worker', note: 'no' }] }],
    });
    expect(result[0].memory.notes).toHaveLength(1000);
    expect(executions.listRecentForLoop).toHaveBeenCalledWith(WORKER, `s-${WORKER}`, 5);
    expect(directives.listToLoop).toHaveBeenCalledWith('u1', WORKER, 10);
  });

  it("shows a worker's hold and alarm, without the alarm's run id", async () => {
    const since = new Date('2026-11-05T10:00:00Z');
    const hold = { kind: 'capacity', at: since };
    const alarm = { kind: 'long_run', reason: 'Run going for 90 min', since, executionId: 'x-long' };
    workerOverrides = { hold, alarm };
    const { loops: result } = JSON.parse(await run(tools(), 'loop_oversee_status', { loopId: WORKER }));
    expect(result[0].hold).toEqual({ kind: 'capacity', at: since.toISOString() });
    expect(result[0].alarm).toEqual({ kind: 'long_run', reason: 'Run going for 90 min', since: since.toISOString() });
  });

  it('defaults to every watched loop the owner still has', async () => {
    const { loops: result } = JSON.parse(await run(tools(), 'loop_oversee_status', {}));
    expect(result.map((loop: { loopId: string }) => loop.loopId)).toEqual([WORKER]);
  });

  it('refuses an unwatched loop', async () => {
    expect(await run(tools(), 'loop_oversee_status', { loopId: UNWATCHED })).toBe('Error: loop not found');
  });

  it("is 'loop not found' once the overseer itself is gone", async () => {
    loops.findByIdAndUserId.mockResolvedValue(null);
    expect(await run(tools(), 'loop_oversee_status', {})).toBe('Error: loop not found');
    expect(await run(tools(), 'loop_oversee_status', { loopId: WORKER })).toBe('Error: loop not found');
  });
});

describe('loop_directive_respond', () => {
  const workerTools = () => buildLoopDirectiveTools({ userId: 'u1', loopId: WORKER, executionId: 'x-worker' });
  const respond = (params: Record<string, unknown>) =>
    run(workerTools(), 'loop_directive_respond', { directiveId: 'd1', ...params });

  it.each([
    ['accepted', 'open', ['open'], undefined],
    ['pushed_back', 'accepted', ['open', 'accepted'], 'tests catch regressions'],
    ['done', 'accepted', ['open', 'accepted'], undefined],
  ])('records %s from %s as a worker reply', async (outcome, state, from, note) => {
    directives.findByIdForUser.mockResolvedValue(directive({ state }));
    expect(JSON.parse(await respond({ outcome, note }))).toEqual({ id: 'd1', state: outcome });
    expect(directives.transition).toHaveBeenCalledWith('d1', 'u1', from, outcome, {
      by: 'worker',
      outcome,
      ...(note && { note }),
      executionId: 'x-worker',
      at: expect.any(Date),
    });
  });

  it('refuses a push back without a note', async () => {
    directives.findByIdForUser.mockResolvedValue(directive());
    expect(await respond({ outcome: 'pushed_back', note: ' ' })).toBe('Error: note is required to push back');
    expect(directives.transition).not.toHaveBeenCalled();
  });

  it("answering another loop's directive is 'directive not found'", async () => {
    directives.findByIdForUser.mockResolvedValue(directive({ loopId: UNWATCHED }));
    expect(await respond({ outcome: 'accepted' })).toBe('Error: directive not found');
    directives.findByIdForUser.mockResolvedValue(null);
    expect(await respond({ outcome: 'accepted' })).toBe('Error: directive not found');
    expect(directives.transition).not.toHaveBeenCalled();
  });

  it('refuses to answer a withdrawn or done directive', async () => {
    for (const state of ['withdrawn', 'done']) {
      directives.findByIdForUser.mockResolvedValue(directive({ state }));
      expect(await respond({ outcome: 'accepted' })).toBe(`Error: directive is ${state}`);
    }
    expect(directives.transition).not.toHaveBeenCalled();
  });

  it('reports a lost race with the owner as a conflict', async () => {
    directives.findByIdForUser.mockResolvedValue(directive());
    directives.transition.mockResolvedValue(null);
    expect(await respond({ outcome: 'done' })).toMatch(/^Error: directive changed while answering/);
  });

  it('rejects an unknown outcome', async () => {
    directives.findByIdForUser.mockResolvedValue(directive());
    expect(await respond({ outcome: 'ignored' })).toMatch(/^Error: outcome must be one of/);
  });
});

describe('overseer actions', () => {
  const tools = (executionId = 'x1') => buildLoopDirectiveTools({ userId: 'u1', loopId: OVERSEER, executionId });
  const act = (name: 'loop_run_now' | 'loop_resume', params: Record<string, unknown> = {}, executionId?: string) =>
    run(tools(executionId), name, { loopId: WORKER, reason: ' Ready tickets waiting ', ...params });
  const actionRow = (action: string, instruction: string) => ({
    loopId: WORKER,
    userId: 'u1',
    fromLoopId: OVERSEER,
    fromLoopName: 'Overseer',
    executionId: 'x1',
    instruction,
    reason: 'Ready tickets waiting',
    state: 'done',
    action,
    replies: [],
  });

  describe('loop_run_now', () => {
    it('makes a live watched loop due and logs a done run_now row, writing nothing else', async () => {
      const result = JSON.parse(await act('loop_run_now'));
      expect(result).toMatchObject({ id: 'd-new', loopId: WORKER, due: true, running: false });
      expect(loops.makeDueNow).toHaveBeenCalledWith(WORKER, expect.any(Date));
      expect(directives.create).toHaveBeenCalledWith(actionRow('run_now', 'Run now'));
      expect(loops.updateForUser).not.toHaveBeenCalled();
      expect(dispatch.requestLoopDispatch).toHaveBeenCalledWith(WORKER, expect.anything());
      expect(dispatch.pushLoopChanged).toHaveBeenCalledWith('u1', WORKER, expect.anything());
      expect(result.note).toMatch(/within seconds/);
      expect(result.note).not.toMatch(/5 minutes|scheduler tick/);
    });

    it('logs nothing when the loop stopped being live before the write', async () => {
      loops.makeDueNow.mockResolvedValueOnce(false);
      expect(await act('loop_run_now')).toBe('Error: loop changed before it could be run; it is no longer live');
      expect(directives.create).not.toHaveBeenCalled();
    });

    it('still succeeds with a run in flight, and says so', async () => {
      workerOverrides = { activeExecutionIds: ['x-worker'] };
      const result = JSON.parse(await act('loop_run_now'));
      expect(result).toMatchObject({ running: true });
      expect(result.note).toMatch(/when a lane frees up/);
    });

    it.each(['paused', 'needs_you', 'error', 'draft'])('refuses a %s loop', async status => {
      workerOverrides = { status };
      expect(await act('loop_run_now')).toBe(`Error: loop is ${status}; only a live loop can be run now`);
      expect(loops.makeDueNow).not.toHaveBeenCalled();
      expect(directives.create).not.toHaveBeenCalled();
      expect(dispatch.requestLoopDispatch).not.toHaveBeenCalled();
    });

    it('refuses an unwatched loop, a missing reason, and the 6th action of a run', async () => {
      expect(await act('loop_run_now', { loopId: UNWATCHED })).toBe('Error: loop not found');
      expect(await act('loop_run_now', { reason: ' ' })).toBe('Error: reason is required');
      directives.countByExecution.mockResolvedValue(MAX_DIRECTIVES_PER_RUN);
      expect(await act('loop_run_now')).toBe(
        `Error: at most ${MAX_DIRECTIVES_PER_RUN} directives can be issued per run`
      );
      expect(loops.makeDueNow).not.toHaveBeenCalled();
    });
  });

  describe('loop_resume', () => {
    it.each(['error', 'needs_you'])(
      'sets a watched %s loop live, resets failures and logs a resume row',
      async status => {
        workerOverrides = { status, statusReason: 'Run failed', consecutiveFailures: 3, lastRunAt: new Date() };
        expect(JSON.parse(await act('loop_resume'))).toMatchObject({ id: 'd-new', loopId: WORKER, status: 'live' });
        const [id, userId, patch, expected] = loops.updateForUser.mock.calls[0];
        expect([id, userId, expected]).toEqual([WORKER, 'u1', status]);
        // Only the status fields: goal, tools, schedule, model, stages and budget have no write path here.
        expect(patch).toEqual({
          status: 'live',
          nextRunAt: expect.any(Date),
          consecutiveFailures: 0,
          statusReason: null,
          autoResume: null,
        });
        expect(directives.create).toHaveBeenCalledWith(actionRow('resume', `Resume (was ${status}: Run failed)`));
        expect(directives.countActionsSince).toHaveBeenCalledWith(WORKER, 'resume', expect.any(Date));
        // Restarted from a stop, it runs now rather than an interval after its last run, and is dispatched.
        expect(patch.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(dispatch.requestLoopDispatch).toHaveBeenCalledWith(WORKER, expect.anything());
      }
    );

    it.each([
      ['an owner pause', { status: 'paused' }],
      ['a budget pause', { status: 'paused', autoResume: 'budget', statusReason: 'Daily budget reached' }],
      ['a credit pause', { status: 'paused', autoResume: 'credits', statusReason: 'Out of credits' }],
      ['an all-loops budget pause', { status: 'paused', autoResume: 'budget', statusReason: 'All-loops' }],
      ['a draft', { status: 'draft' }],
      ['a live loop', { status: 'live' }],
    ])('refuses %s', async (_label, overrides) => {
      workerOverrides = overrides;
      expect(await act('loop_resume')).toBe(
        `Error: loop is ${overrides.status}; only a needs_you or error loop can be resumed`
      );
      expect(loops.updateForUser).not.toHaveBeenCalled();
      expect(directives.create).not.toHaveBeenCalled();
    });

    it('refuses a second resume of the same worker within 24 h', async () => {
      workerOverrides = { status: 'error' };
      directives.countActionsSince.mockResolvedValue(1);
      expect(await act('loop_resume')).toBe('Error: already resumed in the last 24 h; leave it to the owner');
      expect(loops.updateForUser).not.toHaveBeenCalled();
      expect(dispatch.requestLoopDispatch).not.toHaveBeenCalled();
    });

    it('reports a lost race with the owner as a conflict and logs nothing', async () => {
      workerOverrides = { status: 'error' };
      loops.updateForUser.mockResolvedValue(null);
      expect(await act('loop_resume')).toBe('Error: loop changed while resuming');
      expect(directives.create).not.toHaveBeenCalled();
    });
  });

  it('neither tool schema takes more than the loop and a reason', () => {
    const built = tools();
    for (const name of ['loop_run_now', 'loop_resume']) {
      const schema = built[name].implementation({ userId: 'u1' } as never).toolSchema;
      expect(Object.keys(schema.parameters.properties as object).sort()).toEqual(['loopId', 'reason']);
    }
  });
});
