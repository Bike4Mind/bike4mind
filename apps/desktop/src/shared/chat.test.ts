import { describe, expect, it } from 'vitest';
import { isTurnBudgetStop } from './chat';

describe('isTurnBudgetStop', () => {
  it('covers every budget the agent loop enforces', () => {
    // Guards the pairing this predicate exists for: main sets these three, and the thread draws
    // a Continue for whatever it admits. A budget added on one side and not here reaches
    // neither, and silently goes back to being a dead end.
    expect(['tool_turn_limit', 'turn_time_limit', 'tool_stall_limit'].every(isTurnBudgetStop)).toBe(true);
  });

  it('leaves the stops that are not the loop running out of budget', () => {
    // A finished reply, a server-side truncation and the user pressing Stop are all things
    // Continue must not offer to carry on.
    expect([undefined, 'stop', 'end_turn', 'max_tokens', 'aborted'].some(isTurnBudgetStop)).toBe(false);
  });
});
