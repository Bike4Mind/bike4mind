import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalLoopStore } from './LocalLoopStore';
import { testLoop } from './testLoop';
import { createTicket, runTicketTool, updateTicket, type ToolRun } from './ticketTools';

const setup = () => {
  const store = new LocalLoopStore(join(mkdtempSync(join(tmpdir(), 'b4m-loop-tools-')), 'l.sqlite'), () => 'a');
  const loop = store.putLoop(testLoop());
  const run: ToolRun = { loopId: loop.id, runId: 'run-1', creates: 0 };
  const asked = vi.fn();
  const call = (tool: string, input: Record<string, unknown>) => runTicketTool(store, run, tool, input, asked);
  return { store, loop, run, asked, call };
};

describe('loop ticket tools', () => {
  it('files a ticket the run sets a priority on, as an agent priority', () => {
    const { store, call } = setup();
    const created = JSON.parse(call('loop_ticket_create', { title: 'Add docs', priority: 'p1' }));
    expect(created).toMatchObject({ title: 'Add docs', stage: 'todo', status: 'open', priority: 'p1' });
    expect(store.ticket(created.id)).toMatchObject({ prioritySetBy: 'agent', stageHistory: [{ by: 'run' }] });
  });

  it('returns a refusal to the model instead of throwing', () => {
    const { call } = setup();
    expect(call('loop_ticket_create', { title: 'x', status: 'blocked' })).toBe(
      'Error: A reason is required to block a ticket'
    );
    expect(call('loop_ticket_update', { id: 'nope', title: 'x' })).toBe('Error: ticket not found');
  });

  it('caps the tickets one run files', () => {
    const { run, call } = setup();
    run.creates = 20;
    expect(call('loop_ticket_create', { title: 'one too many' })).toMatch(/^Error: at most 20/);
  });

  it('parks a ticket on a question once, and tells the scheduler', () => {
    const { store, loop, asked, call } = setup();
    const ticket = createTicket(store, loop, { title: 'Pick a name' }, 'owner');
    call('loop_ticket_unsure', { id: ticket.id, question: 'Which name?' });
    expect(store.ticket(ticket.id)).toMatchObject({ status: 'blocked', statusReason: 'Unsure: Which name?' });
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ id: ticket.id }), 'Which name?');
    expect(call('loop_ticket_unsure', { id: ticket.id, question: 'Again?' })).toContain('already waiting');
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('refuses a dependency cycle and a dependency outside the loop', () => {
    const { store, loop } = setup();
    const a = createTicket(store, loop, { title: 'a' }, 'owner');
    const b = createTicket(store, loop, { title: 'b', dependencies: [a.id] }, 'owner');
    expect(() => updateTicket(store, loop, a, { dependencies: [b.id] }, 'owner')).toThrow('cannot depend on itself');
    expect(() => createTicket(store, loop, { title: 'c', dependencies: ['elsewhere'] }, 'owner')).toThrow(
      'not a ticket of this loop'
    );
  });

  it('splits a ticket into children that wait on earlier siblings, all or nothing', () => {
    const { store, loop, call } = setup();
    const ticket = createTicket(store, loop, { title: 'Big' }, 'owner');
    const bad = call('loop_ticket_split', {
      id: ticket.id,
      children: [{ title: 'one', priority: 'p2' }, { title: 'two' }],
    });
    expect(bad).toBe('Error: children[1].priority is required');
    expect(store.tickets(loop.id)).toHaveLength(1);

    const result = JSON.parse(
      call('loop_ticket_split', {
        id: ticket.id,
        children: [
          { title: 'one', priority: 'p2' },
          { title: 'two', priority: 'p1', dependencies: ['$0'] },
        ],
      })
    );
    expect(result.epic).toMatchObject({ status: 'blocked', blockedOn: 'dependencies', epic: true });
    expect(store.ticket(result.children[1])?.dependencies).toEqual([result.children[0]]);
  });

  it("starts an owner-moved ticket's run count over", () => {
    const { store, loop } = setup();
    const ticket = store.putTicket({ ...createTicket(store, loop, { title: 'a' }, 'owner'), runCount: 2 });
    expect(updateTicket(store, loop, ticket, { stage: 'doing' }, 'owner').runCount).toBe(0);
    expect(updateTicket(store, loop, store.ticket(ticket.id)!, { title: 'b' }, 'run').runCount).toBe(0);
  });
});
