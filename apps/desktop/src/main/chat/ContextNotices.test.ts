import { describe, expect, it, vi } from 'vitest';
import { ContextNotices } from './ContextNotices';

describe('ContextNotices', () => {
  it('emits every notice and keeps only the held kinds in force', () => {
    const emit = vi.fn();
    const notices = new ContextNotices(emit);

    notices.show('s1', 'At 80%', 'run-budget');
    notices.show('s1', 'Large conversation', 'context-size');
    notices.show('s1', 'Plain message');

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: 'context-notice', sessionId: 's1', message: 'At 80%', kind: 'run-budget' },
      { type: 'context-notice', sessionId: 's1', message: 'Large conversation', kind: 'context-size' },
      { type: 'context-notice', sessionId: 's1', message: 'Plain message' },
    ]);
    expect(notices.active('s1')).toEqual([{ kind: 'run-budget', message: 'At 80%' }]);
  });

  it('replaces a held notice of the same kind and withdraws it with the clear it emits', () => {
    const emit = vi.fn();
    const notices = new ContextNotices(emit);
    notices.show('s1', 'At 80%', 'run-budget');
    notices.show('s1', 'At 85%', 'run-budget');
    expect(notices.active('s1')).toEqual([{ kind: 'run-budget', message: 'At 85%' }]);

    notices.clear('s1', 'run-budget');

    expect(emit).toHaveBeenLastCalledWith({ type: 'context-notice-cleared', sessionId: 's1', kind: 'run-budget' });
    expect(notices.active('s1')).toEqual([]);
  });

  it('forgets a deleted session silently and keeps sessions apart', () => {
    const emit = vi.fn();
    const notices = new ContextNotices(emit);
    notices.show('s1', 'At 80%', 'run-budget');
    notices.show('s2', 'At 90%', 'run-budget');
    emit.mockClear();

    notices.forget('s1');

    expect(emit).not.toHaveBeenCalled();
    expect(notices.active('s1')).toEqual([]);
    expect(notices.active('s2')).toEqual([{ kind: 'run-budget', message: 'At 90%' }]);
  });
});
