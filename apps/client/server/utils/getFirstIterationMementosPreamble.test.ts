import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import {
  getFirstIterationMementosPreamble,
  type MementoRetrievalAdapters,
  type MementoRetrievalExecution,
} from './getFirstIterationMementosPreamble';

const getRelevantMementosMock =
  vi.fn<(...args: unknown[]) => Promise<Array<{ memento: { id: string; summary: string }; similarity: number }>>>();

vi.mock('@bike4mind/services', () => ({
  mementoService: {
    getRelevantMementos: (...args: unknown[]) => getRelevantMementosMock(...args),
  },
}));

const makeExecution = (overrides: Partial<MementoRetrievalExecution> = {}): MementoRetrievalExecution => ({
  id: 'exec-1',
  userId: 'user-1',
  query: 'what hobbies do I have',
  enableMementos: true,
  ...overrides,
});

const makeAdapters = (): MementoRetrievalAdapters => ({
  db: {
    mementos: {} as MementoRetrievalAdapters['db']['mementos'],
    apiKeys: {} as MementoRetrievalAdapters['db']['apiKeys'],
    adminSettings: {} as MementoRetrievalAdapters['db']['adminSettings'],
  },
});

const makeLogger = (): Logger => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  } as unknown as Logger;
};

describe('getFirstIterationMementosPreamble', () => {
  beforeEach(() => {
    getRelevantMementosMock.mockReset();
    getRelevantMementosMock.mockResolvedValue([]);
  });

  it('returns a formatted preamble and mementoIds on the happy path', async () => {
    getRelevantMementosMock.mockResolvedValueOnce([
      { memento: { id: 'm1', summary: 'User enjoys playing chess on Saturdays' }, similarity: 0.92 },
      { memento: { id: 'm2', summary: 'User prefers TypeScript over JavaScript' }, similarity: 0.81 },
    ]);
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(makeExecution(), makeAdapters(), logger);

    expect(getRelevantMementosMock).toHaveBeenCalledTimes(1);
    // Verify the call passes userId, query, and the topK / minSimilarity that
    // match MementoFeature so agent-mode and chat-mode pull the same set.
    const [userId, prompt, options] = getRelevantMementosMock.mock.calls[0] as unknown as [
      string,
      string,
      { topK: number; minSimilarity: number },
    ];
    expect(userId).toBe('user-1');
    expect(prompt).toBe('what hobbies do I have');
    expect(options.topK).toBe(10);
    expect(options.minSimilarity).toBe(0.75);

    expect(preamble).toContain('[KNOWN FACTS ABOUT THE USER');
    expect(preamble).toContain('[92% relevant] User enjoys playing chess on Saturdays');
    expect(preamble).toContain('[81% relevant] User prefers TypeScript over JavaScript');
    expect(mementoIds).toEqual(['m1', 'm2']);
    expect(logger.info).toHaveBeenCalledWith('[Mementos] Injected mementos into first-iteration context', {
      executionId: 'exec-1',
      count: 2,
    });
  });

  it('returns empty preamble and empty mementoIds when enableMementos is false', async () => {
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution({ enableMementos: false }),
      makeAdapters(),
      logger
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('returns empty preamble and empty mementoIds when enableMementos is undefined', async () => {
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution({ enableMementos: undefined }),
      makeAdapters(),
      logger
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('returns empty preamble and empty mementoIds when parentExecutionId is set (subagent / DAG child)', async () => {
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution({ parentExecutionId: 'parent-exec-99' }),
      makeAdapters(),
      logger
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('returns empty preamble and empty mementoIds when no mementos clear the similarity threshold', async () => {
    getRelevantMementosMock.mockResolvedValueOnce([]);
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(makeExecution(), makeAdapters(), logger);

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith('[Mementos] No relevant mementos found for first iteration', {
      executionId: 'exec-1',
    });
  });

  it('swallows retrieval errors, warn-logs, and returns empty preamble and empty mementoIds', async () => {
    getRelevantMementosMock.mockRejectedValueOnce(new Error('embedding API down'));
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(makeExecution(), makeAdapters(), logger);

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[Mementos] Failed to retrieve mementos for first iteration — proceeding without preamble',
      { executionId: 'exec-1', error: 'embedding API down' }
    );
  });

  it('sanitizes line-terminator characters in memento summaries', async () => {
    getRelevantMementosMock.mockResolvedValueOnce([
      { memento: { id: 'm1', summary: 'User likes\nchess\rand tennis' }, similarity: 0.9 },
    ]);
    const logger = makeLogger();

    const { preamble } = await getFirstIterationMementosPreamble(makeExecution(), makeAdapters(), logger);

    expect(preamble).toContain('User likes chess and tennis');
    expect(preamble).not.toContain('User likes\nchess');
    expect(preamble).not.toContain('chess\rand');
  });
});
