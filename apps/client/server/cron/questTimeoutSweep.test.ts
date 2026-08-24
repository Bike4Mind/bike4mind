import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindStaleRunning = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  questRepository: {
    findStaleRunning: (...args: unknown[]) => mockFindStaleRunning(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
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

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  StandardUnit: { Count: 'Count' },
}));

import { handler } from './questTimeoutSweep';

describe('questTimeoutSweep cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindStaleRunning.mockResolvedValue([]);
    mockUpdate.mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve({ id: data.id, ...data, updatedAt: new Date().toISOString() })
    );
  });

  it('returns zero recovered when no stuck quests exist', async () => {
    const result = await handler();
    expect(result).toEqual({ status: 'OK', recovered: 0 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('recovers a stuck quest with no content as a timeout error', async () => {
    mockFindStaleRunning.mockResolvedValue([
      {
        id: 'q-1',
        status: 'running',
        reply: null,
        replies: [],
        images: [],
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
      },
    ]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 1 });
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-1', status: 'done', type: 'error' }));
  });

  it('recovers a stuck quest with content by flipping status only (no error clobber)', async () => {
    mockFindStaleRunning.mockResolvedValue([
      {
        id: 'q-2',
        status: 'running',
        reply: 'partial answer',
        replies: ['partial answer'],
        images: [],
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
      },
    ]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 1 });
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-2', status: 'done' }));
    expect(mockUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('recovers multiple stuck quests in one sweep', async () => {
    mockFindStaleRunning.mockResolvedValue([
      {
        id: 'q-a',
        status: 'running',
        reply: null,
        replies: [],
        images: [],
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
      },
      {
        id: 'q-b',
        status: 'running',
        reply: 'content',
        replies: ['content'],
        images: ['img.png'],
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
      },
    ]);

    const result = await handler();

    expect(result).toEqual({ status: 'OK', recovered: 2 });
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});
