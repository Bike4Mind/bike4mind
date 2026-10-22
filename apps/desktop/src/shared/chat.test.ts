import { describe, expect, it } from 'vitest';
import { isTurnBudgetStop, lastBoundaryIndex, messagesSinceBoundary, type ChatMessage } from './chat';

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

function message(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content: id, createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

const boundary = (id: string, kind: 'clear' | 'compact' = 'clear'): ChatMessage =>
  message(id, { system: true, boundary: { kind }, content: kind === 'compact' ? 'summary' : '' });

describe('messagesSinceBoundary', () => {
  it('is the whole conversation when it has no boundary', () => {
    const messages = [message('a'), message('b')];
    expect(messagesSinceBoundary(messages)).toEqual(messages);
    expect(lastBoundaryIndex(messages)).toBe(-1);
  });

  it('drops what came before and keeps the marker, so a summary leads what is sent', () => {
    const marker = boundary('m', 'compact');
    expect(messagesSinceBoundary([message('a'), message('b'), marker, message('c')])).toEqual([marker, message('c')]);
  });

  // The whole reason a boundary is a marker rather than a stored cut: compacting a compacted
  // conversation needs no bookkeeping, because only the last marker is ever consulted.
  it('lets a second boundary supersede the first', () => {
    const first = boundary('m1', 'compact');
    const second = boundary('m2', 'compact');
    const kept = messagesSinceBoundary([message('a'), first, message('b'), second, message('c')]);
    expect(kept).toEqual([second, message('c')]);
    expect(kept).not.toContain(first);
  });

  it('keeps nothing but the marker straight after a clear', () => {
    const marker = boundary('m');
    expect(messagesSinceBoundary([message('a'), message('b'), marker])).toEqual([marker]);
  });
});
