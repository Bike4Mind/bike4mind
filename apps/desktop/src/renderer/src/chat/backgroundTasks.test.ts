import { describe, expect, it } from 'vitest';
import { runningTasksLabel, splitTasks, taskElapsedMs, taskTitle } from './backgroundTasks';
import { formatElapsed } from './statusLine';

describe('runningTasksLabel', () => {
  it('is singular at one and plural everywhere else', () => {
    expect(runningTasksLabel(1)).toBe('1 running task');
    expect(runningTasksLabel(3)).toBe('3 running tasks');
    expect(runningTasksLabel(0)).toBe('0 running tasks');
  });
});

describe('taskElapsedMs', () => {
  const now = Date.parse('2026-01-01T00:05:00.000Z');

  it('runs up to now while the task is still going', () => {
    expect(taskElapsedMs({ startedAt: '2026-01-01T00:03:44.000Z' }, now)).toBe(76_000);
    expect(formatElapsed(taskElapsedMs({ startedAt: '2026-01-01T00:03:44.000Z' }, now))).toBe('1m 16s');
  });

  it('freezes a finished task at its own end, whatever now is', () => {
    const ended = { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:09.000Z' };
    expect(taskElapsedMs(ended, now)).toBe(9000);
    expect(taskElapsedMs(ended, now + 600_000)).toBe(9000);
  });

  it('reports zero rather than NaN for a timestamp it cannot read', () => {
    expect(taskElapsedMs({ startedAt: 'not a date' }, now)).toBe(0);
    expect(taskElapsedMs({ startedAt: '2026-01-01T00:04:00.000Z', endedAt: 'not a date' }, now)).toBe(60_000);
  });

  it('never goes negative when the clocks disagree', () => {
    expect(taskElapsedMs({ startedAt: '2026-01-01T00:09:00.000Z' }, now)).toBe(0);
  });
});

describe('taskTitle', () => {
  it('keeps the first line only', () => {
    expect(taskTitle('pnpm dev')).toBe('pnpm dev');
    expect(taskTitle('  pnpm dev --filter web  ')).toBe('pnpm dev --filter web');
    expect(taskTitle('cat <<EOF > f\nline\nEOF')).toBe('cat <<EOF > f');
  });

  it('falls back to a word rather than an empty card', () => {
    expect(taskTitle('\n\n')).toBe('command');
  });
});

describe('splitTasks', () => {
  it('sends everything that is not running to the finished list', () => {
    const tasks = [
      { id: 'a', status: 'running' as const },
      { id: 'b', status: 'exited' as const },
      { id: 'c', status: 'killed' as const },
      { id: 'd', status: 'failed' as const },
      { id: 'e', status: 'running' as const },
    ];
    const { running, finished } = splitTasks(tasks);
    expect(running.map(entry => entry.id)).toEqual(['a', 'e']);
    expect(finished.map(entry => entry.id)).toEqual(['b', 'c', 'd']);
  });
});
