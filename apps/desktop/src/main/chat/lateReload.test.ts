import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLateReload } from './lateReload';

describe('createLateReload', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reloads once for several notices inside the window', () => {
    const reload = vi.fn();
    const late = createLateReload(reload, 250);
    late.notify();
    vi.advanceTimersByTime(100);
    late.notify();
    late.notify();
    vi.advanceTimersByTime(150);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads again for a notice after the last reload', () => {
    const reload = vi.fn();
    const late = createLateReload(reload, 250);
    late.notify();
    vi.advanceTimersByTime(250);
    late.notify();
    vi.advanceTimersByTime(250);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('drops a pending reload when stopped', () => {
    const reload = vi.fn();
    const late = createLateReload(reload, 250);
    late.notify();
    late.stop();
    vi.advanceTimersByTime(1_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('ignores notices after stop', () => {
    const reload = vi.fn();
    const late = createLateReload(reload, 250);
    late.stop();
    late.notify();
    vi.advanceTimersByTime(1_000);
    expect(reload).not.toHaveBeenCalled();
  });
});
