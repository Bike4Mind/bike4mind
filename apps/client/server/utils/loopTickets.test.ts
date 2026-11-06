import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ loopRepository: {}, workItemRepository: {} }));
vi.mock('./loopValidation', () => ({ assertLoopsEnabled: vi.fn() }));

import { advancePatch, ticketMovePatch } from './loopTickets';

const loop = { stages: ['todo', 'doing', 'done'] };

describe('ticketMovePatch', () => {
  it('refuses in_progress and a loop with fewer than two stages', () => {
    expect(() => ticketMovePatch(loop, undefined, { status: 'in_progress' })).toThrow(/in_progress/);
    expect(() => ticketMovePatch({ stages: ['only'] }, { stage: 'only', status: 'open' }, {})).toThrow(/two stages/);
  });

  it('closing moves the ticket to the last stage', () => {
    expect(ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { status: 'closed' })).toMatchObject({
      stage: 'done',
      status: 'closed',
      closedAt: expect.any(Date),
    });
  });

  it('keeps closedAt on a ticket that is already closed', () => {
    expect(ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { status: 'closed' }).closedAt).toBeUndefined();
  });

  it('moving out of the last stage reopens it', () => {
    expect(ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { stage: 'todo' })).toMatchObject({
      stage: 'todo',
      status: 'open',
      closedAt: null,
    });
  });

  it('a stage move keeps a blocked ticket blocked with its reason', () => {
    const patch = ticketMovePatch(loop, { stage: 'todo', status: 'blocked' }, { stage: 'doing' });
    expect(patch).toMatchObject({ stage: 'doing', status: 'blocked' });
    expect(patch.statusReason).toBeUndefined();
  });

  it('a stage move keeps a running ticket in_progress', () => {
    expect(ticketMovePatch(loop, { stage: 'todo', status: 'in_progress' }, { stage: 'doing' }).status).toBe(
      'in_progress'
    );
  });

  it('blocking needs a reason; unblocking clears it', () => {
    expect(() => ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { status: 'blocked' })).toThrow(/reason/);
    expect(ticketMovePatch(loop, { stage: 'todo', status: 'blocked' }, { status: 'open' }).statusReason).toBeNull();
  });
});

describe('advancePatch', () => {
  it('moves one stage on, and closes at the last stage', () => {
    expect(advancePatch(loop, { stage: 'todo' })).toMatchObject({ stage: 'doing', status: 'open' });
    expect(advancePatch(loop, { stage: 'doing' })).toMatchObject({ stage: 'done', status: 'closed' });
  });
});
