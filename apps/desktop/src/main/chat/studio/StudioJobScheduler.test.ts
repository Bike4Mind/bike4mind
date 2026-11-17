import { afterEach, expect, it, vi } from 'vitest';
import { StudioJobScheduler } from './StudioJobScheduler';

afterEach(() => vi.useRealTimers());
it('recovers one workspace without a pane and stops at account changes and disposal', async () => {
  vi.useFakeTimers();
  let scope: string | null = 'first';
  const recover = vi.fn(async () => undefined);
  const changed = vi.fn();
  const scheduler = new StudioJobScheduler({
    scope: () => scope,
    sessions: async () => [{ id: 'parent' }, { id: 'child' }],
    workspace: async () => ({ workspaceId: 'family' }),
    recover,
    changed,
  });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(recover).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(recover).toHaveBeenCalledTimes(2);
  scope = null;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(recover).toHaveBeenCalledTimes(2);
  scheduler.dispose();
  scope = 'second';
  await vi.advanceTimersByTimeAsync(30_000);
  expect(recover).toHaveBeenCalledTimes(2);
});
