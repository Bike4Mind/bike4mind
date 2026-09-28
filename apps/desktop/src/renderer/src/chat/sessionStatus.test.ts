import { describe, expect, it } from 'vitest';
import type { ChatSessionStatus } from '@shared/chat';
import { applyStatusEvents, STATUS_LABEL } from './sessionStatus';

const empty: ReadonlyMap<string, ChatSessionStatus> = new Map();

describe('applyStatusEvents', () => {
  it('records a busy session', () => {
    const next = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);
    expect(next.get('a')).toBe('processing');
  });

  it('stores idle as absence rather than as a value', () => {
    const busy = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);
    const idle = applyStatusEvents(busy, [{ sessionId: 'a', status: 'done' }]);

    expect(idle.has('a')).toBe(false);
    expect(idle.size).toBe(0);
  });

  // The sidebar re-renders on identity, so a repeated status must not produce a new map.
  it('returns the same map when nothing changed', () => {
    const busy = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);

    expect(applyStatusEvents(busy, [{ sessionId: 'a', status: 'processing' }])).toBe(busy);
    expect(applyStatusEvents(busy, [])).toBe(busy);
    expect(applyStatusEvents(empty, [{ sessionId: 'b', status: 'done' }])).toBe(empty);
  });

  it('never mutates the map it was given', () => {
    const busy = applyStatusEvents(empty, [{ sessionId: 'a', status: 'processing' }]);
    applyStatusEvents(busy, [{ sessionId: 'a', status: 'done' }]);

    expect(busy.get('a')).toBe('processing');
  });

  it('lets a later event in the same batch overtake an earlier one', () => {
    const next = applyStatusEvents(empty, [
      { sessionId: 'a', status: 'processing' },
      { sessionId: 'a', status: 'needs-action' },
      { sessionId: 'a', status: 'processing' },
      { sessionId: 'a', status: 'done' },
    ]);

    expect(next.has('a')).toBe(false);
  });

  it('keeps sessions apart', () => {
    const next = applyStatusEvents(empty, [
      { sessionId: 'a', status: 'processing' },
      { sessionId: 'b', status: 'needs-action' },
    ]);

    expect(next.get('a')).toBe('processing');
    expect(next.get('b')).toBe('needs-action');
  });

  it('names every state, so a badge always has a label', () => {
    const states: ChatSessionStatus[] = ['processing', 'needs-action', 'done'];
    for (const state of states) expect(STATUS_LABEL[state]).toBeTruthy();
  });
});
