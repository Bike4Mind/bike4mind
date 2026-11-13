import { describe, expect, it } from 'vitest';
import type { IWorkItem } from '../types/entities/WorkItemTypes';
import { pickReady, untriaged } from './pick';

const stages = ['todo', 'doing', 'review', 'done'];
let seq = 0;
const ticket = (patch: Partial<IWorkItem>): IWorkItem =>
  ({
    id: `t${++seq}`,
    userId: 'u',
    title: 't',
    status: 'open',
    dependencies: [],
    stage: 'todo',
    priority: 'p2',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)),
    updatedAt: new Date(),
    ...patch,
  }) as IWorkItem;

describe('pickReady', () => {
  it('orders by priority, then later stage, then oldest', () => {
    const oldP2 = ticket({ id: 'oldP2' });
    const newP2Review = ticket({ id: 'newP2Review', stage: 'review' });
    const p1 = ticket({ id: 'p1', priority: 'p1' });
    const newP2 = ticket({ id: 'newP2' });
    const picked = pickReady([newP2, oldP2, newP2Review, p1], stages, () => undefined);
    expect(picked.map(t => t.id)).toEqual(['p1', 'newP2Review', 'oldP2', 'newP2']);
  });

  it('skips untriaged, not-open, last-stage tickets and open dependencies; a deleted dependency counts as closed', () => {
    const tickets = [
      ticket({ id: 'untriaged', priority: undefined }),
      ticket({ id: 'blocked', status: 'blocked' }),
      ticket({ id: 'closed', status: 'closed', stage: 'done' }),
      ticket({ id: 'waits', dependencies: ['dep'] }),
      ticket({ id: 'gone', dependencies: ['missing'] }),
      ticket({ id: 'ok', dependencies: ['closedDep'] }),
    ];
    const status = (id: string) => ({ dep: 'open', closedDep: 'closed' })[id] as IWorkItem['status'] | undefined;
    expect(pickReady(tickets, stages, status).map(t => t.id)).toEqual(['gone', 'ok']);
  });

  it('honours onlyPriorities', () => {
    const tickets = [ticket({ id: 'a', priority: 'p2' }), ticket({ id: 'b', priority: 'p0' })];
    expect(pickReady(tickets, stages, () => undefined, ['p0', 'p1']).map(t => t.id)).toEqual(['b']);
  });
});

describe('untriaged', () => {
  it('lists open tickets with no priority, oldest first, never epics', () => {
    const b = ticket({ id: 'b', priority: undefined });
    const a = ticket({ id: 'a', priority: undefined, createdAt: new Date(Date.UTC(2025, 0, 1)) });
    const epic = ticket({ id: 'epic', priority: undefined, epic: true });
    const set = ticket({ id: 'set' });
    expect(untriaged([b, epic, set, a]).map(t => t.id)).toEqual(['a', 'b']);
  });
});
