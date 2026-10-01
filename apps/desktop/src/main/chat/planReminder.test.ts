import { describe, expect, it } from 'vitest';
import type { TodoItem } from '@shared/todos';
import { PLAN_REMINDER_ROUNDS, stalePlanReminder, unfinishedPlanReminder } from './planReminder';

const plan = (...statuses: TodoItem['status'][]): TodoItem[] =>
  statuses.map((status, index) => ({ content: `step ${index + 1}`, status }));

describe('stalePlanReminder', () => {
  it('fires once the threshold is reached', () => {
    const unfinished = plan('completed', 'in_progress');
    for (let rounds = 0; rounds < PLAN_REMINDER_ROUNDS; rounds += 1) {
      expect(stalePlanReminder(unfinished, rounds)).toBeNull();
    }
    expect(stalePlanReminder(unfinished, PLAN_REMINDER_ROUNDS)).toMatch(/todo_write/);
  });

  it('re-arms rather than firing every round after the first time', () => {
    const unfinished = plan('pending');
    const fired = Array.from({ length: 3 * PLAN_REMINDER_ROUNDS }, (_, index) =>
      stalePlanReminder(unfinished, index + 1) === null ? '.' : 'x'
    ).join('');
    expect(fired).toBe('..x..x..x');
  });

  it('says nothing when every item is completed', () => {
    expect(stalePlanReminder(plan('completed', 'completed'), PLAN_REMINDER_ROUNDS)).toBeNull();
  });

  it('says nothing when there is no plan at all', () => {
    expect(stalePlanReminder(null, PLAN_REMINDER_ROUNDS)).toBeNull();
    expect(stalePlanReminder([], PLAN_REMINDER_ROUNDS)).toBeNull();
  });

  it('wraps the nudge so the model reads it as a reminder, not as the tool result', () => {
    const text = stalePlanReminder(plan('pending'), PLAN_REMINDER_ROUNDS);
    expect(text).toMatch(/^<system-reminder>\n/);
    expect(text).toMatch(/<\/system-reminder>$/);
  });
});

describe('unfinishedPlanReminder', () => {
  it('fires on an item left in progress, and names it', () => {
    const text = unfinishedPlanReminder([
      { content: 'Run typecheck and lint', status: 'in_progress' },
      { content: 'Open a PR', status: 'pending' },
    ]);
    expect(text).toMatch(/Run typecheck and lint/);
    expect(text).toMatch(/todo_write/);
  });

  it('stays quiet when the remaining items are all pending', () => {
    expect(unfinishedPlanReminder(plan('completed', 'pending', 'pending'))).toBeNull();
  });

  it('stays quiet on a finished plan or no plan', () => {
    expect(unfinishedPlanReminder(plan('completed'))).toBeNull();
    expect(unfinishedPlanReminder(null)).toBeNull();
  });
});
