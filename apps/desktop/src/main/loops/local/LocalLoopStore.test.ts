import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORK_ITEM_STAGE_HISTORY_MAX } from '@bike4mind/common';
import { ticketMovePatch } from '@bike4mind/common/loops';
import type { LocalRun } from '@shared/localLoops';
import { describe, expect, it, vi } from 'vitest';
import { applyTicketPatch, LocalLoopStore } from './LocalLoopStore';
import { testLoop } from './testLoop';
import { createTicket, updateTicket } from './ticketTools';

const open = (scope: { current: string | null }, changed = vi.fn()) => {
  const path = join(mkdtempSync(join(tmpdir(), 'b4m-local-loops-')), 'local-loops.sqlite');
  return { store: new LocalLoopStore(path, () => scope.current, changed), changed, path };
};

describe('LocalLoopStore', () => {
  it('keeps each scope to itself and refuses writes signed out', () => {
    const scope = { current: 'a' as string | null };
    const { store } = open(scope);
    store.putLoop(testLoop());
    scope.current = 'b';
    expect(store.loops()).toEqual([]);
    expect(store.loop('loop-1')).toBeNull();
    scope.current = null;
    expect(() => store.putLoop(testLoop())).toThrow('Sign in');
    scope.current = 'a';
    expect(store.loops()).toHaveLength(1);
  });

  it('survives a reopen, and tells the listener once per loop a transaction touched', () => {
    const scope = { current: 'a' };
    const { store, changed, path } = open(scope);
    store.transaction(() => {
      store.putLoop(testLoop());
      createTicket(store, store.loop('loop-1')!, { title: 'one' }, 'owner');
      createTicket(store, store.loop('loop-1')!, { title: 'two' }, 'owner');
    });
    expect(changed).toHaveBeenCalledTimes(1);
    store.close();
    const again = new LocalLoopStore(path, () => scope.current);
    expect(again.tickets('loop-1').map(ticket => ticket.title)).toEqual(['one', 'two']);
  });

  it('rolls a failed transaction back', () => {
    const { store } = open({ current: 'a' });
    store.putLoop(testLoop());
    expect(() =>
      store.transaction(() => {
        createTicket(store, store.loop('loop-1')!, { title: 'kept?' }, 'owner');
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.tickets('loop-1')).toEqual([]);
  });

  it('leaves a ticket unchanged when a move is refused', () => {
    const { store } = open({ current: 'a' });
    const loop = store.putLoop(testLoop());
    const ticket = createTicket(store, loop, { title: 'one' }, 'owner');
    expect(() => updateTicket(store, loop, ticket, { status: 'blocked' }, 'owner')).toThrow('reason is required');
    expect(() => updateTicket(store, loop, ticket, { stage: 'nowhere' }, 'owner')).toThrow('stage must be one of');
    expect(store.ticket(ticket.id)).toEqual(ticket);
  });

  it('records who moved a ticket, keeping the last entries only', () => {
    const { store } = open({ current: 'a' });
    const loop = store.putLoop(testLoop());
    let ticket = createTicket(store, loop, { title: 'one' }, 'owner');
    expect(ticket.stageHistory).toEqual([{ stage: 'todo', at: expect.any(String), by: 'owner' }]);
    for (let i = 0; i < WORK_ITEM_STAGE_HISTORY_MAX + 5; i++) {
      ticket = applyTicketPatch(ticket, ticketMovePatch(loop, ticket, { stage: i % 2 ? 'todo' : 'doing' }, 'run'));
    }
    expect(ticket.stageHistory).toHaveLength(WORK_ITEM_STAGE_HISTORY_MAX);
    expect(ticket.stageHistory.at(-1)?.by).toBe('run');
  });

  it("counts today's spend from runs started since 00:00 UTC, in flight ones too", () => {
    const { store } = open({ current: 'a' });
    store.putLoop(testLoop());
    store.putLoop(testLoop({ id: 'loop-2' }));
    const run = (id: string, loopId: string, startedAt: string, credits: number, endedAt?: string): LocalRun => ({
      id,
      loopId,
      kind: 'ticket',
      model: 'm',
      fallback: false,
      startedAt,
      credits,
      ...(endedAt ? { endedAt } : {}),
    });
    store.putRun(run('yesterday', 'loop-1', '2026-01-01T23:59:00.000Z', 50, '2026-01-02T00:10:00.000Z'));
    store.putRun(run('done', 'loop-1', '2026-01-02T01:00:00.000Z', 3, '2026-01-02T01:10:00.000Z'));
    store.putRun(run('live', 'loop-1', '2026-01-02T02:00:00.000Z', 2));
    store.putRun(run('other', 'loop-2', '2026-01-02T02:00:00.000Z', 4));
    const now = new Date('2026-01-02T03:00:00.000Z');
    expect(store.spentToday('loop-1', now)).toBe(5);
    expect(store.spentTodayAllLoops(now)).toBe(9);
    expect(
      store
        .openRuns()
        .map(r => r.id)
        .sort()
    ).toEqual(['live', 'other']);
  });

  it('deletes a loop with its tickets, runs and events', () => {
    const { store } = open({ current: 'a' });
    const loop = store.putLoop(testLoop());
    createTicket(store, loop, { title: 'one' }, 'owner');
    store.putEvent({ id: 'e1', loopId: loop.id, kind: 'capped', reason: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    store.deleteLoop(loop.id);
    expect(store.loops()).toEqual([]);
    expect(store.tickets(loop.id)).toEqual([]);
    expect(store.events(loop.id)).toEqual([]);
  });
});
