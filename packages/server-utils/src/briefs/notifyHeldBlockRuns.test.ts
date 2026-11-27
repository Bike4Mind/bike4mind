import { describe, expect, it, vi } from 'vitest';
import { notifyHeldBlockRuns, type HeldBlockRunsDeps } from './notifyHeldBlockRuns';

const block = { start: new Date('2026-11-17T04:00:00Z'), end: new Date('2026-11-17T05:00:00Z') };

const makeDeps = (over: { count?: number | Error; user?: object | null } = {}) => {
  const count = over.count ?? 0;
  return {
    users: { findById: vi.fn().mockResolvedValue(over.user === undefined ? { preferences: {} } : over.user) },
    runs: {
      countRunsFinishedBetween:
        count instanceof Error ? vi.fn().mockRejectedValue(count) : vi.fn().mockResolvedValue(count),
    },
    push: vi.fn().mockResolvedValue(undefined),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
};
const asDeps = (deps: ReturnType<typeof makeDeps>) => deps as unknown as HeldBlockRunsDeps;

describe('notifyHeldBlockRuns', () => {
  it('sends nothing when no run finished during the block', async () => {
    const deps = makeDeps({ count: 0 });
    await notifyHeldBlockRuns('u1', block, asDeps(deps));
    expect(deps.runs.countRunsFinishedBetween).toHaveBeenCalledWith('u1', block.start, block.end);
    expect(deps.push).not.toHaveBeenCalled();
  });

  it.each([
    [1, '1 agent run finished during your busy block.'],
    [3, '3 agent runs finished during your busy block.'],
  ])('sends one digest push for %i finished run(s)', async (count, body) => {
    const deps = makeDeps({ count });
    await notifyHeldBlockRuns('u1', block, asDeps(deps));
    expect(deps.push).toHaveBeenCalledTimes(1);
    expect(deps.push).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        category: 'agent_completed',
        body,
        busyBlockDigest: true,
        collapseId: `busy_block_runs:${block.end.toISOString()}`,
      })
    );
  });

  it.each([
    ['brief_ready pushes are off', { preferences: { pushNotifications: { brief_ready: false } } }],
    ['the user is gone', null],
  ])('sends nothing when %s, since sendPush held nothing', async (_case, user) => {
    const deps = makeDeps({ count: 2, user });
    await notifyHeldBlockRuns('u1', block, asDeps(deps));
    expect(deps.runs.countRunsFinishedBetween).not.toHaveBeenCalled();
    expect(deps.push).not.toHaveBeenCalled();
  });

  it('logs and swallows a failed count', async () => {
    const deps = makeDeps({ count: new Error('db down') });
    await expect(notifyHeldBlockRuns('u1', block, asDeps(deps))).resolves.toBeUndefined();
    expect(deps.push).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledTimes(1);
  });
});
