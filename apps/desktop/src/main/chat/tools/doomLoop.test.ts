import { describe, expect, it } from 'vitest';
import { DoomLoopTracker } from './doomLoop';

describe('DoomLoopTracker', () => {
  it('flags the third identical call in a row, and every one after it', () => {
    const tracker = new DoomLoopTracker();
    const call = () => tracker.record('s', 'bash_execute', { command: 'ls' });
    expect([call(), call(), call(), call()]).toEqual([false, false, true, true]);
  });

  it('is broken by a different call or different input', () => {
    const tracker = new DoomLoopTracker();
    tracker.record('s', 'bash_execute', { command: 'ls' });
    tracker.record('s', 'bash_execute', { command: 'ls' });
    expect(tracker.record('s', 'bash_execute', { command: 'ls -a' })).toBe(false);
    expect(tracker.record('s', 'file_read', { command: 'ls -a' })).toBe(false);
  });

  it('counts a shell command reworded only in its description as the same call', () => {
    const tracker = new DoomLoopTracker();
    const call = (description?: string) =>
      tracker.record('s', 'bash_execute', { command: 'ls', ...(description ? { description } : {}) });
    expect([call('Lists files'), call(), call('Shows the folder')]).toEqual([false, false, true]);

    const other = new DoomLoopTracker();
    other.record('s', 'file_read', { path: 'a', description: 'one' });
    other.record('s', 'file_read', { path: 'a', description: 'two' });
    expect(other.record('s', 'file_read', { path: 'a', description: 'three' })).toBe(false);
  });

  it('counts each conversation on its own', () => {
    const tracker = new DoomLoopTracker();
    tracker.record('a', 't', {});
    tracker.record('a', 't', {});
    expect(tracker.record('b', 't', {})).toBe(false);
    tracker.forget('a');
    expect(tracker.record('a', 't', {})).toBe(false);
  });
});
