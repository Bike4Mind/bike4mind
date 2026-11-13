import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ loopRepository: {}, workItemRepository: {} }));
vi.mock('./loopValidation', () => ({ assertLoopsEnabled: vi.fn() }));

import { advancePatch, initialStageHistory, ticketMovePatch } from './loopTickets';

const loop = { stages: ['todo', 'doing', 'done'] };

describe('ticketMovePatch', () => {
  it('refuses in_progress and a loop with fewer than two stages', () => {
    expect(() => ticketMovePatch(loop, undefined, { status: 'in_progress' }, 'owner')).toThrow(/in_progress/);
    expect(() => ticketMovePatch({ stages: ['only'] }, { stage: 'only', status: 'open' }, {}, 'owner')).toThrow(
      /two stages/
    );
  });

  it('closing moves the ticket to the last stage', () => {
    expect(ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { status: 'closed' }, 'owner')).toMatchObject({
      stage: 'done',
      status: 'closed',
      closedAt: expect.any(Date),
    });
  });

  it('keeps closedAt on a ticket that is already closed', () => {
    expect(
      ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { status: 'closed' }, 'owner').closedAt
    ).toBeUndefined();
  });

  it('moving out of the last stage reopens it', () => {
    expect(ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { stage: 'todo' }, 'owner')).toMatchObject({
      stage: 'todo',
      status: 'open',
      closedAt: null,
    });
  });

  it('a stage move keeps a blocked ticket blocked with its reason', () => {
    const patch = ticketMovePatch(loop, { stage: 'todo', status: 'blocked' }, { stage: 'doing' }, 'owner');
    expect(patch).toMatchObject({ stage: 'doing', status: 'blocked' });
    expect(patch.statusReason).toBeUndefined();
  });

  it('a stage move keeps a running ticket in_progress', () => {
    expect(ticketMovePatch(loop, { stage: 'todo', status: 'in_progress' }, { stage: 'doing' }, 'owner').status).toBe(
      'in_progress'
    );
  });

  it('blocking needs a reason; unblocking clears it', () => {
    expect(() => ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { status: 'blocked' }, 'owner')).toThrow(
      /reason/
    );
    expect(
      ticketMovePatch(loop, { stage: 'todo', status: 'blocked' }, { status: 'open' }, 'owner').statusReason
    ).toBeNull();
  });
});

describe('advancePatch', () => {
  it('moves one stage on, and closes at the last stage', () => {
    expect(advancePatch(loop, { stage: 'todo' })).toMatchObject({ stage: 'doing', status: 'open' });
    expect(advancePatch(loop, { stage: 'doing' })).toMatchObject({ stage: 'done', status: 'closed' });
  });

  it('only releases a ticket whose stage changed during the run, so it does not skip a stage', () => {
    const started = new Date('2026-11-11T10:00:00Z');
    const movedBy = (at: string) => ({
      stage: 'doing',
      stageHistory: [{ stage: 'doing', at: new Date(at), by: 'run' as const }],
    });
    expect(advancePatch(loop, movedBy('2026-11-11T10:05:00Z'), started)).toEqual({
      status: 'open',
      statusReason: null,
    });
    expect(advancePatch(loop, movedBy('2026-11-11T09:55:00Z'), started)).toMatchObject({ stage: 'done' });
    expect(advancePatch(loop, movedBy('2026-11-11T10:05:00Z'))).toMatchObject({ stage: 'done' });
  });

  it('clears the owner rating when a closed ticket reopens, and only then', () => {
    expect(ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { status: 'open' }, 'owner')).toMatchObject({
      ownerRating: null,
    });
    expect(
      ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { status: 'closed' }, 'owner')
    ).not.toHaveProperty('ownerRating');
    expect(ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { stage: 'doing' }, 'owner')).not.toHaveProperty(
      'ownerRating'
    );
  });

  it('records a stage history entry only when the stage changes, and always on create', () => {
    expect(ticketMovePatch(loop, undefined, {}, 'run').stageHistoryEntry).toMatchObject({ stage: 'todo', by: 'run' });
    expect(
      ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { stage: 'doing' }, 'owner').stageHistoryEntry
    ).toMatchObject({ stage: 'doing', by: 'owner' });
    expect(
      ticketMovePatch(loop, { stage: 'todo', status: 'open' }, { status: 'blocked', reason: 'x' }, 'run')
        .stageHistoryEntry
    ).toBeUndefined();
    // A reopen moves the ticket back a stage.
    expect(
      ticketMovePatch(loop, { stage: 'done', status: 'closed' }, { status: 'open' }, 'owner').stageHistoryEntry
    ).toMatchObject({ stage: 'doing' });
    expect(advancePatch(loop, { stage: 'todo' }).stageHistoryEntry).toMatchObject({ stage: 'doing', by: 'scheduler' });
    const create = ticketMovePatch(loop, undefined, { stage: 'doing' }, 'handoff');
    expect(initialStageHistory(create)).toEqual({ stageHistory: [create.stageHistoryEntry] });
  });
});
