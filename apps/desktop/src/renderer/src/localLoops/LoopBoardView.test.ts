import { describe, expect, it } from 'vitest';
import type { LocalTicket } from '@shared/localLoops';
import { dropMove } from './LoopBoardView';

const ticket = (patch: Partial<LocalTicket> = {}): LocalTicket => ({
  id: 't1',
  loopId: 'l1',
  title: 'a',
  stage: 'todo',
  status: 'open',
  dependencies: [],
  runCount: 0,
  stageHistory: [],
  createdAt: '',
  updatedAt: '',
  ...patch,
});

describe('dropMove', () => {
  it('moves an open ticket to the column it lands on, and ignores a drop on its own column', () => {
    expect(dropMove(ticket(), { stage: 'doing' })).toEqual({ stage: 'doing' });
    expect(dropMove(ticket(), { stage: 'todo' })).toBeNull();
  });

  it('reopens a blocked or closed ticket dropped on a column', () => {
    expect(dropMove(ticket({ status: 'blocked' }), { stage: 'todo' })).toEqual({ stage: 'todo', status: 'open' });
    expect(dropMove(ticket({ status: 'closed' }), { stage: 'doing' })).toEqual({ stage: 'doing', status: 'open' });
  });

  it('blocks a ticket dropped on Blocked, as the owner', () => {
    expect(dropMove(ticket(), { blocked: true })).toEqual({ status: 'blocked', reason: 'Blocked by owner' });
    expect(dropMove(ticket({ status: 'blocked' }), { blocked: true })).toBeNull();
  });

  it('never moves a running ticket by drag', () => {
    expect(dropMove(ticket({ status: 'in_progress' }), { stage: 'doing' })).toBeNull();
  });
});
