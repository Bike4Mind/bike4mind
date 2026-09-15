import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindStaleRunning = vi.fn();
const mockSettleIfUnfinished = vi.fn();

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  questRepository: {
    findStaleRunning: (...args: unknown[]) => mockFindStaleRunning(...args),
    settleIfUnfinished: (...args: unknown[]) => mockSettleIfUnfinished(...args),
  },
}));

vi.mock('@bike4mind/observability', () => {
  const mockLogger: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    Logger: vi.fn(function () {
      return mockLogger;
    }),
  };
});

vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://localhost:27017/%STAGE%' },
}));

vi.mock('sst', () => ({
  Resource: { App: { stage: 'dev' } },
}));

const mockEmitMetric = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  StandardUnit: { Count: 'Count' },
}));

import { handler } from './questTimeoutSweep';
import { QUEST_TIMEOUT_THRESHOLD_MS } from '@server/chatCompletion/questTimeoutRecovery';

const staleQuest = (overrides: Record<string, unknown> = {}) => ({
  id: 'q-1',
  status: 'running',
  reply: null,
  replies: [],
  images: [],
  videos: [],
  updatedAt: new Date(Date.now() - 300_000).toISOString(),
  ...overrides,
});

const metricValue = (name: string) => mockEmitMetric.mock.calls.find(call => call[1] === name)?.[2];

describe('questTimeoutSweep cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindStaleRunning.mockResolvedValue([]);
    mockSettleIfUnfinished.mockResolvedValue(true);
  });

  it('returns zero recovered when no stuck quests exist', async () => {
    const result = await handler();
    expect(result).toEqual({ status: 'OK', recovered: 0 });
    expect(mockSettleIfUnfinished).not.toHaveBeenCalled();
  });

  it('bounds the candidate query by the liveness threshold, the age floor, and an explicit limit', async () => {
    await handler();

    expect(mockFindStaleRunning).toHaveBeenCalledTimes(1);
    const [opts] = mockFindStaleRunning.mock.calls[0];
    expect(opts.limit).toBe(500);

    // Liveness threshold on the upper bound; a 7-day floor on the lower one, so a steady-state
    // run cannot mass-rewrite the historical backlog of quests abandoned at 'running'.
    const now = Date.now();
    expect(now - opts.olderThan.getTime()).toBeGreaterThanOrEqual(QUEST_TIMEOUT_THRESHOLD_MS);
    expect(now - opts.olderThan.getTime()).toBeLessThan(QUEST_TIMEOUT_THRESHOLD_MS + 60_000);
    expect(now - opts.newerThan.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(now - opts.newerThan.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('recovers a stuck quest with no content as a timeout error', async () => {
    mockFindStaleRunning.mockResolvedValue([staleQuest()]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 1 });
    expect(mockSettleIfUnfinished).toHaveBeenCalledWith(
      'q-1',
      expect.objectContaining({ status: 'done', type: 'error' })
    );
  });

  it('recovers a stuck quest with content by flipping status only (no error clobber)', async () => {
    mockFindStaleRunning.mockResolvedValue([
      staleQuest({ id: 'q-2', reply: 'partial answer', replies: ['partial answer'] }),
    ]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 1 });
    expect(mockSettleIfUnfinished).toHaveBeenCalledWith('q-2', { status: 'done' });
  });

  it.each([
    ['videos', { videos: ['clip.mp4'] }],
    ['structuredReplies', { structuredReplies: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }],
    ['toolResults', { toolResults: [{ tool_use_id: 'call_1', content: 'tool output' }] }],
  ])('treats %s as renderable content rather than stamping a timeout error', async (_field, content) => {
    mockFindStaleRunning.mockResolvedValue([staleQuest(content)]);

    await handler();

    // A tool-heavy run can produce a fully renderable answer with reply/replies/images empty;
    // grading that "nothing to show" writes an error next to output the user can see.
    expect(mockSettleIfUnfinished).toHaveBeenCalledWith('q-1', { status: 'done' });
  });

  it('recovers multiple stuck quests in one sweep', async () => {
    mockFindStaleRunning.mockResolvedValue([
      staleQuest({ id: 'q-a' }),
      staleQuest({ id: 'q-b', reply: 'content', replies: ['content'], images: ['img.png'] }),
    ]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 2 });
    expect(mockSettleIfUnfinished).toHaveBeenCalledTimes(2);
  });

  it('continues recovering remaining quests when one write fails', async () => {
    mockFindStaleRunning.mockResolvedValue([staleQuest({ id: 'q-fail' }), staleQuest({ id: 'q-ok' })]);
    mockSettleIfUnfinished.mockRejectedValueOnce(new Error('transient DB error')).mockResolvedValue(true);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 1 });
    expect(mockSettleIfUnfinished).toHaveBeenCalledTimes(2);
  });

  it('does not count a quest that finished between the read and the write', async () => {
    mockFindStaleRunning.mockResolvedValue([staleQuest({ id: 'q-raced' }), staleQuest({ id: 'q-stuck' })]);
    // The compare-and-set found nothing to patch: the run committed its real answer in the gap.
    mockSettleIfUnfinished.mockResolvedValueOnce(false).mockResolvedValue(true);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 1 });
    expect(metricValue('TimeoutSweepRecovered')).toBe(1);
  });

  it('reports candidate depth separately from recovered count', async () => {
    mockFindStaleRunning.mockResolvedValue([staleQuest({ id: 'q-a' }), staleQuest({ id: 'q-b' })]);
    mockSettleIfUnfinished.mockResolvedValueOnce(false).mockResolvedValue(true);

    await handler();

    // Two distinct numbers: `recovered` alone cannot tell a drained backlog from a capped run.
    expect(metricValue('TimeoutSweepCandidates')).toBe(2);
    expect(metricValue('TimeoutSweepRecovered')).toBe(1);
  });

  it('emits the run metric even when the candidate query throws', async () => {
    mockFindStaleRunning.mockRejectedValue(new Error('cannot reach primary'));

    await expect(handler()).rejects.toThrow('cannot reach primary');

    // Ordered ahead of the query so a totally broken sweep is distinguishable from one that
    // was never scheduled.
    expect(metricValue('TimeoutSweepRuns')).toBe(1);
  });
});
