import { afterEach, expect, it, vi } from 'vitest';
import { createStudioDiagnostics } from './StudioDiagnostics';
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

it('continues to a healthy workspace when another cannot be resolved, with bounded diagnostics', async () => {
  vi.useFakeTimers();
  const logger = { warn: vi.fn() };
  const recover = vi.fn(async () => undefined);
  const scheduler = new StudioJobScheduler({
    diagnostic: createStudioDiagnostics(logger),
    scope: () => 'account',
    sessions: async () => [{ id: 'broken-session' }, { id: 'healthy-session' }],
    workspace: async id => {
      if (id === 'broken-session') throw new Error('private prompt TOKEN https://signed.test/secret');
      return { workspaceId: 'healthy-family' };
    },
    recover,
    changed: vi.fn(),
  });
  try {
    await scheduler.tick();
    expect(recover).toHaveBeenCalledExactlyOnceWith('healthy-session');
    const diagnostics = JSON.stringify(logger.warn.mock.calls);
    expect(diagnostics).toContain('scheduler-workspace');
    for (const secret of ['broken-session', 'private prompt', 'TOKEN', 'signed.test'])
      expect(diagnostics).not.toContain(secret);
  } finally {
    scheduler.dispose();
  }
});
