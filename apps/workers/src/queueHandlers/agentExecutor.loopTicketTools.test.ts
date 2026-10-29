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
}));
vi.mock('@bike4mind/database', () => ({
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
});

describe('resolveLoopTicketTools', () => {
  it('offers the three tools only on a loop run with EnableLoops on', () => {
    expect(resolveLoopTicketTools({ loopId: OWN, loopsEnabled: true, userId: 'u1' }).loopTicketEnabledTools).toEqual(
      LOOP_TICKET_TOOL_NAMES
    );
    for (const off of [
      { loopId: OWN, loopsEnabled: false, userId: 'u1' },
      { loopId: undefined, loopsEnabled: true, userId: 'u1' },
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
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });
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
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });
    expect(await run(tools, 'loop_ticket_create', { title: 'A', loopId: FOREIGN })).toBe('Error: loop not found');
    expect(await run(tools, 'loop_ticket_create', { title: 'A', loopId: 'nope' })).toBe('Error: loop not found');
    expect(items.create).not.toHaveBeenCalled();
  });

  it('returns validation errors to the model', async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });
    expect(await run(tools, 'loop_ticket_create', { title: '' })).toMatch(/^Error: .*title/);
    expect(await run(tools, 'loop_ticket_create', { title: 'A', stage: 'nope' })).toMatch(/^Error: stage must be/);
  });

  it(`stops after ${MAX_TICKET_CREATES_PER_INVOCATION} creates in one invocation`, async () => {
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });
    for (let i = 0; i < MAX_TICKET_CREATES_PER_INVOCATION; i++)
      await run(tools, 'loop_ticket_create', { title: `T${i}` });
    expect(await run(tools, 'loop_ticket_create', { title: 'one too many' })).toMatch(/^Error: at most/);
    expect(items.create).toHaveBeenCalledTimes(MAX_TICKET_CREATES_PER_INVOCATION);
  });
});

describe('loop_ticket_update', () => {
  it('refuses a plain work item as not found', async () => {
    items.findByIdForUser.mockResolvedValue({ id: 'w1', title: 'Plain', status: 'open', dependencies: [] });
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });
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
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });
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
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });

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
    const tools = buildLoopTicketTools({ userId: 'u1', loopId: OWN });

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
