import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const findByUserId = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userUsagePatternSignalsRepository: { findByUserId: (...args: unknown[]) => findByUserId(...args) },
}));

import { getUsageSignalsTool } from './getUsageSignals';

const USER_ID = '65f1a2b3c4d5e6f708192a3b';

const runTool = async (args: unknown) => {
  const context = {
    user: { isAdmin: true },
    userId: 'admin-1',
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as Omit<ToolContext, 'config'>;
  return JSON.parse(await getUsageSignalsTool.implementation(context, undefined).toolFn(args));
};

describe('getUsageSignalsTool', () => {
  beforeEach(() => findByUserId.mockReset());

  it('returns the stored signals', async () => {
    const computedAt = new Date('2026-10-01T00:00:00Z');
    findByUserId.mockResolvedValue({
      id: 'doc-1',
      userId: USER_ID,
      score: 72,
      needsReview: true,
      computedAt,
      signals: [{ id: 'burst', value: 3, triggered: true, weight: 10, explanation: 'many requests' }],
    });

    const result = await runTool({ userId: USER_ID });

    expect(findByUserId).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({
      ok: true,
      data: {
        userId: USER_ID,
        score: 72,
        needsReview: true,
        skipped: null,
        computedAt: computedAt.toISOString(),
        signals: [{ id: 'burst', value: 3, triggered: true, weight: 10, explanation: 'many requests' }],
      },
    });
  });

  it('returns not_found when none are stored', async () => {
    findByUserId.mockResolvedValue(null);

    const result = await runTool({ userId: USER_ID });

    expect(result).toEqual({
      ok: false,
      error: 'not_found',
      message: 'No usage pattern signals computed for this user in the last 30 days',
    });
  });

  it('rejects a non-ObjectId userId as invalid_input', async () => {
    const result = await runTool({ userId: 'not-an-id' });

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(findByUserId).not.toHaveBeenCalled();
  });
});
