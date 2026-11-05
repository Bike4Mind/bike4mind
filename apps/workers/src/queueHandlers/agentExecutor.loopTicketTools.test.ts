import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyToolPermission, LOOP_TICKET_TOOL_NAMES } from '@bike4mind/common';

const loops = vi.hoisted(() => ({ findByIdAndUserId: vi.fn(), makeDueNow: vi.fn() }));
const items = vi.hoisted(() => ({
  findByIdForUser: vi.fn(),
  findManyByIdsForUser: vi.fn(),
  detectDependencyCycle: vi.fn(),
  listForUser: vi.fn(),
  create: vi.fn(),
  updateForUser: vi.fn(),
  findNextReadyForLoop: vi.fn(),
  listUntriagedForLoop: vi.fn(),
  softDeleteForUser: vi.fn(),
}));
const events = vi.hoisted(() => ({ recordUnsure: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  loopEventRepository: events,
  loopRepository: loops,
  workItemRepository: items,
  adminSettingsRepository: { getSettingsValue: async () => true },
}));

import {
  buildLoopTicketTools,
  MAX_TICKET_CREATES_PER_INVOCATION,
  resolveLoopTicketTools,
} from './agentExecutor.loopTicketTools';

const OWN = '507f1f77bcf86cd799439011';
const SIBLING = '507f1f77bcf86cd799439012';
const FOREIGN = '507f1f77bcf86cd799439013';
const loop = (id: string) => ({ id, userId: 'u1', status: 'live', stages: ['todo', 'doing', 'done'] });

const run = (tools: ReturnType<typeof buildLoopTicketTools>, name: string, params: unknown) =>
  tools[name].implementation({ userId: 'u1' } as never).toolFn(params) as Promise<string>;

beforeEach(() => {
  vi.clearAllMocks();
  // Ownership is the repository's userId scope: another user's loop simply is not found.
  loops.findByIdAndUserId.mockImplementation(async (id: string, userId: string) =>
    userId === 'u1' && (id === OWN || id === SIBLING) ? loop(id) : null
  );
  items.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: 't-new', ...doc }));
  items.updateForUser.mockImplementation(async (id: string, _u: string, patch: Record<string, unknown>) => ({
    id,
    dependencies: [],
    ...patch,
  }));
  items.findNextReadyForLoop.mockResolvedValue(null);
  items.listUntriagedForLoop.mockResolvedValue([]);
});

describe('resolveLoopTicketTools', () => {
  it('offers the tools only on a loop run with EnableLoops on', () => {
    expect(
      resolveLoopTicketTools({ loopId: OWN, loopsEnabled: true, userId: 'u1', executionId: 'exec-1' })
        .loopTicketEnabledTools
    ).toEqual(LOOP_TICKET_TOOL_NAMES);
    for (const off of [
      { loopId: OWN, loopsEnabled: false, userId: 'u1', executionId: 'exec-1' },
      { loopId: undefined, loopsEnabled: true, userId: 'u1', executionId: 'exec-1' },
    ]) {
      const { loopTicketEnabledTools, loopTicketExternalTools } = resolveLoopTicketTools(off);
      expect(loopTicketEnabledTools).toEqual([]);
      expect(loopTicketExternalTools).toEqual({});
    }
  });

  it('every tool is allowed on a headless loop run, whose approvedTools carry the names', () => {
    const approved = ['web_search', ...LOOP_TICKET_TOOL_NAMES];
    for (const name of LOOP_TICKET_TOOL_NAMES) expect(classifyToolPermission(name, approved, [])).toBe('allowed');
    // Without the pre-approval the write tools would be refused on a run with nobody to ask.
    expect(classifyToolPermission('loop_ticket_create', [], [])).toBe('needs_approval');
  });
});

describe('loop_ticket_create', () => {
  it('files into its own loop by default and into another loop of the same user', async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    await run(tools, 'loop_ticket_create', { title: 'A' });
    await run(tools, 'loop_ticket_create', { title: 'B', loopId: SIBLING, stage: 'doing' });

    expect(items.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ loopId: OWN, stage: 'todo', status: 'open' })
    );
    expect(items.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ loopId: SIBLING, stage: 'doing', userId: 'u1' })
    );
  });

  it("refuses another user's loop with the same text as a missing one", async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    expect(await run(tools, 'loop_ticket_create', { title: 'A', loopId: FOREIGN })).toBe('Error: loop not found');
    expect(await run(tools, 'loop_ticket_create', { title: 'A', loopId: 'nope' })).toBe('Error: loop not found');
    expect(items.create).not.toHaveBeenCalled();
  });

  it('returns validation errors to the model', async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    expect(await run(tools, 'loop_ticket_create', { title: '' })).toMatch(/^Error: .*title/);
    expect(await run(tools, 'loop_ticket_create', { title: 'A', stage: 'nope' })).toMatch(/^Error: stage must be/);
  });

  it(`stops after ${MAX_TICKET_CREATES_PER_INVOCATION} creates in one invocation`, async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    for (let i = 0; i < MAX_TICKET_CREATES_PER_INVOCATION; i++)
      await run(tools, 'loop_ticket_create', { title: `T${i}` });
    expect(await run(tools, 'loop_ticket_create', { title: 'one too many' })).toMatch(/^Error: at most/);
    expect(items.create).toHaveBeenCalledTimes(MAX_TICKET_CREATES_PER_INVOCATION);
  });
  it('files a blocked owner step with its reason, and requires the reason', async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    expect(await run(tools, 'loop_ticket_create', { title: 'A', status: 'blocked' })).toMatch(/reason is required/);
    expect(await run(tools, 'loop_ticket_create', { title: 'A', status: 'closed' })).toMatch(/^Error: status must be/);
    expect(items.create).not.toHaveBeenCalled();

    await run(tools, 'loop_ticket_create', { title: 'Approve spend', status: 'blocked', reason: ' needs a yes ' });
    expect(items.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blocked', statusReason: 'needs a yes', stage: 'todo' })
    );
  });
});

describe('priority and blockedOn', () => {
  const DEP = '507f1f77bcf86cd799439021';
  const tools = () => buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

  it('loop_ticket_create stores a priority as agent-set (none: untriaged) and parks on an open dependency', async () => {
    items.findManyByIdsForUser.mockResolvedValue([{ id: DEP, status: 'open', dependencies: [] }]);
    expect(JSON.parse(await run(tools(), 'loop_ticket_create', { title: 'A' }))).not.toHaveProperty('priority');
    expect(items.create.mock.lastCall![0]).not.toHaveProperty('priority');
    await run(tools(), 'loop_ticket_create', { title: 'B', priority: 'p0' });
    expect(items.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ priority: 'p0', prioritySetBy: 'agent', prioritySetAt: expect.any(Date) })
    );

    const parked = JSON.parse(
      await run(tools(), 'loop_ticket_create', {
        title: 'C',
        dependencies: [DEP],
        status: 'blocked',
        blockedOn: 'dependencies',
      })
    );
    expect(parked).toMatchObject({
      status: 'blocked',
      statusReason: 'Waiting on dependencies',
      blockedOn: 'dependencies',
    });
  });

  it('loop_ticket_create rejects an unknown priority or blockedOn, and blockedOn without an open dependency', async () => {
    expect(await run(tools(), 'loop_ticket_create', { title: 'A', priority: 'urgent' })).toMatch(/priority must be/);
    expect(await run(tools(), 'loop_ticket_create', { title: 'A', status: 'blocked', blockedOn: 'ci' })).toMatch(
      /blockedOn must be/
    );
    expect(await run(tools(), 'loop_ticket_create', { title: 'A', blockedOn: 'dependencies' })).toMatch(
      /only valid with status blocked/
    );
    items.findManyByIdsForUser.mockResolvedValue([]);
    expect(
      await run(tools(), 'loop_ticket_create', { title: 'A', status: 'blocked', blockedOn: 'dependencies' })
    ).toMatch(/needs an open dependency/);
    expect(items.create).not.toHaveBeenCalled();
  });

  it('loop_ticket_update sets priority, replaces dependencies (rejecting a cycle) and parks on them', async () => {
    items.findByIdForUser.mockResolvedValue({ id: 't1', loopId: OWN, stage: 'todo', status: 'open', dependencies: [] });
    items.findManyByIdsForUser.mockResolvedValue([{ id: DEP, status: 'open', dependencies: [] }]);

    await run(tools(), 'loop_ticket_update', { id: 't1', priority: 'p1' });
    expect(items.updateForUser).toHaveBeenLastCalledWith(
      't1',
      'u1',
      { priority: 'p1', prioritySetBy: 'agent', prioritySetAt: expect.any(Date) },
      'open'
    );

    items.detectDependencyCycle.mockResolvedValueOnce(true);
    expect(await run(tools(), 'loop_ticket_update', { id: 't1', dependencies: [DEP] })).toMatch(/cycle/);

    await run(tools(), 'loop_ticket_update', {
      id: 't1',
      dependencies: [DEP],
      status: 'blocked',
      blockedOn: 'dependencies',
    });
    expect(items.detectDependencyCycle).toHaveBeenLastCalledWith('u1', [DEP], 't1');
    expect(items.updateForUser).toHaveBeenLastCalledWith(
      't1',
      'u1',
      expect.objectContaining({ dependencies: [DEP], status: 'blocked', blockedOn: 'dependencies' }),
      'open'
    );
  });

  it('loop_ticket_update clears blockedOn on a later status or reason change', async () => {
    items.findByIdForUser.mockResolvedValue({
      id: 't1',
      loopId: OWN,
      stage: 'todo',
      status: 'blocked',
      blockedOn: 'dependencies',
      dependencies: [DEP],
    });
    await run(tools(), 'loop_ticket_update', { id: 't1', status: 'open' });
    expect(items.updateForUser.mock.lastCall![2]).toMatchObject({ blockedOn: null });
    await run(tools(), 'loop_ticket_update', { id: 't1', status: 'blocked', reason: 'Needs a login' });
    expect(items.updateForUser.mock.lastCall![2]).toMatchObject({ blockedOn: null, statusReason: 'Needs a login' });
  });
});

describe('loop_ticket_update', () => {
  it('refuses a plain work item as not found', async () => {
    items.findByIdForUser.mockResolvedValue({ id: 'w1', title: 'Plain', status: 'open', dependencies: [] });
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    expect(await run(tools, 'loop_ticket_update', { id: 'w1', status: 'closed' })).toBe('Error: ticket not found');
    expect(items.updateForUser).not.toHaveBeenCalled();
  });

  it('blocks its own ticket with a reason, and requires the reason', async () => {
    items.findByIdForUser.mockResolvedValue({
      id: 't1',
      loopId: OWN,
      stage: 'todo',
      status: 'in_progress',
      dependencies: [],
    });
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    expect(await run(tools, 'loop_ticket_update', { id: 't1', status: 'blocked' })).toMatch(/reason is required/);

    await run(tools, 'loop_ticket_update', { id: 't1', status: 'blocked', reason: 'needs a login' });
    expect(items.updateForUser).toHaveBeenCalledWith(
      't1',
      'u1',
      expect.objectContaining({ status: 'blocked', statusReason: 'needs a login', stage: 'todo' }),
      'in_progress'
    );
  });

  it('tells the model when its loop folded the ticket mid-update, instead of overwriting the fold', async () => {
    items.findByIdForUser.mockResolvedValue({
      id: 't1',
      loopId: OWN,
      stage: 'doing',
      status: 'in_progress',
      dependencies: [],
    });
    items.updateForUser.mockResolvedValueOnce(null);
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

    expect(await run(tools, 'loop_ticket_update', { id: 't1', status: 'closed' })).toMatch(/^Error: ticket changed/);
    expect(items.updateForUser).toHaveBeenCalledWith('t1', 'u1', expect.anything(), 'in_progress');
  });

  it("moves a ticket to another of the user's loops, never to another user's", async () => {
    items.findByIdForUser.mockResolvedValue({
      id: 't1',
      loopId: OWN,
      stage: 'doing',
      status: 'open',
      dependencies: [],
    });
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

    expect(await run(tools, 'loop_ticket_update', { id: 't1', loopId: FOREIGN })).toBe('Error: loop not found');
    await run(tools, 'loop_ticket_update', { id: 't1', loopId: SIBLING });
    expect(items.updateForUser).toHaveBeenCalledWith(
      't1',
      'u1',
      expect.objectContaining({ loopId: SIBLING, stage: 'todo', status: 'open' }),
      'open'
    );
  });
});

describe('loop_ticket_unsure', () => {
  const ticket = (overrides: Record<string, unknown> = {}) => ({
    id: 't1',
    loopId: OWN,
    title: 'Pick a region',
    stage: 'doing',
    status: 'in_progress',
    dependencies: [],
    ...overrides,
  });

  it('records an asked unsure event for the run, then blocks the ticket as Unsure', async () => {
    items.findByIdForUser.mockResolvedValue(ticket());
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

    const result = JSON.parse(await run(tools, 'loop_ticket_unsure', { id: 't1', question: ' EU or US? ' }));

    expect(events.recordUnsure).toHaveBeenCalledTimes(1);
    expect(events.recordUnsure).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'asked',
        loopId: OWN,
        userId: 'u1',
        executionId: 'exec-1',
        workItemId: 't1',
        ticketTitle: 'Pick a region',
        reason: 'EU or US?',
      })
    );
    expect(items.updateForUser).toHaveBeenCalledWith(
      't1',
      'u1',
      expect.objectContaining({ status: 'blocked', statusReason: 'Unsure: EU or US?' }),
      'in_progress'
    );
    expect(result).toMatchObject({ status: 'blocked', statusReason: 'Unsure: EU or US?' });
  });

  it('records the event before parking the ticket, and does not invite a retry when the park loses a race', async () => {
    items.findByIdForUser.mockResolvedValue(ticket());
    items.updateForUser.mockResolvedValueOnce(null);
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

    const result = await run(tools, 'loop_ticket_unsure', { id: 't1', question: 'Q' });

    expect(result).not.toMatch(/^Error/);
    expect(result).toContain('not parked');
    expect(events.recordUnsure.mock.invocationCallOrder[0]).toBeLessThan(
      items.updateForUser.mock.invocationCallOrder[0]
    );
  });

  it('does not ask again while the ticket is already waiting on the owner', async () => {
    items.findByIdForUser.mockResolvedValue(ticket({ status: 'blocked', statusReason: 'Unsure: EU or US?' }));
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

    const result = await run(tools, 'loop_ticket_unsure', { id: 't1', question: 'And which city?' });

    expect(result).not.toMatch(/^Error/);
    expect(result).toContain('already waiting on the owner');
    expect(events.recordUnsure).not.toHaveBeenCalled();
    expect(items.updateForUser).not.toHaveBeenCalled();
  });

  it("refuses an empty question, another loop's ticket and a closed ticket, writing nothing", async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    items.findByIdForUser.mockResolvedValue(ticket());
    expect(await run(tools, 'loop_ticket_unsure', { id: 't1', question: '  ' })).toBe('Error: question is required');
    items.findByIdForUser.mockResolvedValue(ticket({ loopId: SIBLING }));
    expect(await run(tools, 'loop_ticket_unsure', { id: 't1', question: 'Q' })).toBe('Error: ticket not found');
    items.findByIdForUser.mockResolvedValue(ticket({ status: 'closed' }));
    expect(await run(tools, 'loop_ticket_unsure', { id: 't1', question: 'Q' })).toBe('Error: ticket is closed');

    expect(events.recordUnsure).not.toHaveBeenCalled();
    expect(items.updateForUser).not.toHaveBeenCalled();
  });
});

describe('desktop-stage tickets', () => {
  const desktopLoop = { ...loop(OWN), stageConfig: [{ stage: 'doing', runner: 'desktop' }] };
  const ticket = { id: 't1', loopId: OWN, title: 'Ship it', stage: 'doing', status: 'open', dependencies: [] };

  beforeEach(() => {
    loops.findByIdAndUserId.mockImplementation(async (id: string) =>
      id === OWN ? desktopLoop : id === SIBLING ? loop(SIBLING) : null
    );
    items.findByIdForUser.mockResolvedValue(ticket);
  });

  it('refuses to move, edit, block or park a ticket in a desktop stage, writing nothing', async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    for (const params of [
      { id: 't1', stage: 'todo' },
      { id: 't1', title: 'Renamed' },
      { id: 't1', status: 'closed' },
      { id: 't1', status: 'blocked', reason: 'x' },
      { id: 't1', loopId: SIBLING },
    ]) {
      expect(await run(tools, 'loop_ticket_update', params)).toMatch(/^Error: .*desktop/);
    }
    expect(await run(tools, 'loop_ticket_unsure', { id: 't1', question: 'Which?' })).toMatch(/^Error: .*desktop/);
    expect(items.updateForUser).not.toHaveBeenCalled();
    expect(events.recordUnsure).not.toHaveBeenCalled();
  });

  it('sets only the priority of a desktop-stage ticket, so triage can reach it', async () => {
    items.updateForUser.mockResolvedValue({ ...ticket, priority: 'p1' });
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
    expect(await run(tools, 'loop_ticket_update', { id: 't1', priority: 'p1' })).not.toMatch(/^Error/);
    expect(items.updateForUser).toHaveBeenCalledWith(
      't1',
      'u1',
      expect.objectContaining({ priority: 'p1', prioritySetBy: 'agent' }),
      'open'
    );
    expect(await run(tools, 'loop_ticket_update', { id: 't1', priority: 'p1', title: 'x' })).toMatch(
      /^Error: .*desktop/
    );
  });

  it('still moves a cloud-stage ticket into a desktop stage, and marks desktop tickets in the list', async () => {
    items.findByIdForUser.mockResolvedValue({ ...ticket, stage: 'todo' });
    items.listForUser.mockResolvedValue({ data: [ticket, { ...ticket, id: 't2', stage: 'todo' }], hasMore: false });
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });

    await run(tools, 'loop_ticket_update', { id: 't1', stage: 'doing' });
    expect(items.updateForUser).toHaveBeenCalledWith('t1', 'u1', expect.objectContaining({ stage: 'doing' }), 'open');

    const listed = JSON.parse(await run(tools, 'loop_ticket_list', {}));
    expect(listed.desktopStages).toEqual(['doing']);
    expect(listed.tickets.map((t: { id: string; desktopRunner?: boolean }) => [t.id, t.desktopRunner])).toEqual([
      ['t1', true],
      ['t2', undefined],
    ]);
  });
});

describe('loop_ticket_split', () => {
  const DEP = '507f1f77bcf86cd799439021';
  const tools = () => buildLoopTicketTools({ userId: 'u1', loopId: OWN, executionId: 'exec-1' });
  const big = { id: 't-big', loopId: OWN, stage: 'todo', status: 'open', dependencies: [DEP], priority: 'p1' };

  beforeEach(() => {
    let n = 0;
    items.create.mockImplementation(async (doc: Record<string, unknown>) => ({ id: `child-${n++}`, ...doc }));
    items.findByIdForUser.mockResolvedValue(big);
    items.findManyByIdsForUser.mockResolvedValue([{ id: DEP, status: 'open', dependencies: [] }]);
  });

  it('creates the children with their priorities and resolved sibling deps, then parks the ticket as an epic', async () => {
    const result = JSON.parse(
      await run(tools(), 'loop_ticket_split', {
        id: 't-big',
        children: [
          { title: 'Schema', priority: 'p0' },
          { title: 'API', priority: 'p1', dependencies: ['$0'] },
          { title: 'UI', priority: 'p2', dependencies: ['$0', '$1'], stage: 'doing' },
        ],
      })
    );
    expect(items.create).toHaveBeenCalledTimes(3);
    expect(
      items.create.mock.calls.map(([doc]) => [doc.title, doc.priority, doc.prioritySetBy, doc.dependencies])
    ).toEqual([
      ['Schema', 'p0', 'agent', [DEP]],
      ['API', 'p1', 'agent', [DEP, 'child-0']],
      ['UI', 'p2', 'agent', [DEP, 'child-0', 'child-1']],
    ]);
    expect(items.create.mock.calls[2][0]).toMatchObject({ stage: 'doing', status: 'open', loopId: OWN });
    expect(items.updateForUser).toHaveBeenCalledWith(
      't-big',
      'u1',
      expect.objectContaining({
        status: 'blocked',
        blockedOn: 'dependencies',
        dependencies: ['child-0', 'child-1', 'child-2'],
        epic: true,
        statusReason: 'Epic: waiting on 3 child tickets',
        priority: null,
      }),
      'open'
    );
    expect(result).toMatchObject({ children: ['child-0', 'child-1', 'child-2'], epic: { epic: true } });
  });

  it('writes nothing for invalid input', async () => {
    const attempt = (children: unknown) => run(tools(), 'loop_ticket_split', { id: 't-big', children });
    expect(await attempt([{ title: 'Only one', priority: 'p1' }])).toMatch(/2 to 20/);
    expect(await attempt([{ title: 'A', priority: 'p1' }, { title: 'B' }])).toMatch(
      /children\[1\].priority is required/
    );
    expect(
      await attempt([
        { title: 'A', priority: 'p1', dependencies: ['$1'] },
        { title: 'B', priority: 'p1' },
      ])
    ).toMatch(/earlier children/);
    expect(
      await attempt([
        { title: 'A', priority: 'p1' },
        { title: '', priority: 'p1' },
      ])
    ).toMatch(/^Error/);
    items.findByIdForUser.mockResolvedValue({ ...big, status: 'blocked', epic: true });
    expect(
      await attempt([
        { title: 'A', priority: 'p1' },
        { title: 'B', priority: 'p1' },
      ])
    ).toMatch(/only an open/);
    items.findByIdForUser.mockResolvedValue(big);
    expect(
      await attempt([
        { title: 'A', priority: 'p1', stage: 'done' },
        { title: 'B', priority: 'p1' },
      ])
    ).toMatch(/children\[0\] cannot start in the last stage/);
    // A child waiting on the epic it unblocks would never be ready.
    const EPIC = '507f1f77bcf86cd799439022';
    items.findByIdForUser.mockResolvedValue({ ...big, id: EPIC });
    expect(
      await attempt([
        { title: 'A', priority: 'p1', dependencies: [EPIC] },
        { title: 'B', priority: 'p1' },
      ])
    ).toMatch(/cannot depend on itself/);
    expect(items.create).not.toHaveBeenCalled();
    expect(items.updateForUser).not.toHaveBeenCalled();
  });

  it('soft-deletes the children when the ticket changed before it could be parked', async () => {
    items.updateForUser.mockResolvedValue(null);
    const result = await run(tools(), 'loop_ticket_split', {
      id: 't-big',
      children: [
        { title: 'A', priority: 'p1' },
        { title: 'B', priority: 'p2' },
      ],
    });
    expect(result).toMatch(/changed while splitting/);
    expect(items.softDeleteForUser.mock.calls).toEqual([
      ['child-0', 'u1'],
      ['child-1', 'u1'],
    ]);
  });

  it('reports the original error when the cleanup fails too', async () => {
    items.updateForUser.mockResolvedValue(null);
    items.softDeleteForUser.mockRejectedValue(new Error('db down'));
    const result = await run(tools(), 'loop_ticket_split', {
      id: 't-big',
      children: [
        { title: 'A', priority: 'p1' },
        { title: 'B', priority: 'p2' },
      ],
    });
    expect(result).toMatch(/changed while splitting/);
    expect(items.softDeleteForUser.mock.calls).toEqual([
      ['child-0', 'u1'],
      ['child-1', 'u1'],
    ]);
  });
});
