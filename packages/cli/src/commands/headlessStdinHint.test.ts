import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStdin, STDIN_HINT, STDIN_HINT_DELAY_MS } from './headlessCommand';

describe('readStdin hint', () => {
  let fake: PassThrough;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;

  beforeEach(() => {
    vi.useFakeTimers();
    fake = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', original);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('prints the hint once after the delay on a stalled stream', async () => {
    const p = readStdin();
    vi.advanceTimersByTime(STDIN_HINT_DELAY_MS - 1);
    expect(stderrWrite).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stderrWrite).toHaveBeenCalledTimes(1);
    expect(stderrWrite).toHaveBeenCalledWith(STDIN_HINT);
    vi.advanceTimersByTime(30000);
    expect(stderrWrite).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).not.toHaveBeenCalled();
    fake.end('late');
    await expect(p).resolves.toBe('late');
  });

  it('does not print the hint when data arrives first', async () => {
    const p = readStdin();
    fake.write('hello');
    vi.advanceTimersByTime(STDIN_HINT_DELAY_MS * 2);
    expect(stderrWrite).not.toHaveBeenCalled();
    fake.end();
    await expect(p).resolves.toBe('hello');
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('does not print the hint when stdin ends quickly', async () => {
    const p = readStdin();
    fake.end();
    await expect(p).resolves.toBe('');
    vi.advanceTimersByTime(STDIN_HINT_DELAY_MS * 2);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
