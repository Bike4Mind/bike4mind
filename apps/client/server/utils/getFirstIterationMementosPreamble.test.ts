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

/** V2 returns null for a user who is not on V2 - which is what hands control to the V1 path. */
const recallMementosV2Mock =
  vi.fn<(...args: unknown[]) => Promise<Array<{ fact: string; relevance: number }> | null>>();

vi.mock('@server/memory/recallMementosV2', () => ({
  recallMementosV2: (...args: unknown[]) => recallMementosV2Mock(...args),
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
    recallMementosV2Mock.mockReset();
    recallMementosV2Mock.mockResolvedValue(null); // default: user is NOT on V2, so V1 handles it
  });

  it('returns a formatted preamble and mementoIds on the happy path', async () => {
    getRelevantMementosMock.mockResolvedValueOnce([
      { memento: { id: 'm1', summary: 'User enjoys playing chess on Saturdays' }, similarity: 0.92 },
      { memento: { id: 'm2', summary: 'User prefers TypeScript over JavaScript' }, similarity: 0.81 },
    ]);
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(makeExecution(), makeAdapters(), logger);

    expect(getRelevantMementosMock).toHaveBeenCalledTimes(1);
    // The V1 path matches MementoFeature's chat-path params (topK 10, minSimilarity 0.75) so agent-mode
    // and chat-mode pull the same set. This is the flag-OFF path, held byte-for-byte to main.
    const [userId, prompt, options] = getRelevantMementosMock.mock.calls[0] as unknown as [
      string,
      string,
      { topK: number; minSimilarity: number },
    ];
    expect(userId).toBe('user-1');
    expect(prompt).toBe('what hobbies do I have');
    expect(options.topK).toBe(10);
    expect(options.minSimilarity).toBe(0.75);

    // V1 keeps its legacy KNOWN-FACTS preamble with per-memento relevance scores. (The friend-who-
    // remembers framing is the V2 path, asserted separately below.)
    expect(preamble).toContain('User enjoys playing chess on Saturdays');
    expect(preamble).toContain('User prefers TypeScript over JavaScript');
    expect(preamble).toContain('% relevant');
    expect(preamble).toContain('KNOWN FACTS ABOUT THE USER');
    expect(mementoIds).toEqual(['m1', 'm2']);
    expect(logger.info).toHaveBeenCalledWith('[Mementos] Injected mementos into first-iteration context', {
      executionId: 'exec-1',
      count: 2,
    });
  });

  it('returns empty preamble and empty mementoIds when enableMementos is false and the user is not on V2', async () => {
    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution({ enableMementos: false }),
      makeAdapters(),
      makeLogger()
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

  it('serves a V2 user from the ledger and never touches the V1 path', async () => {
    recallMementosV2Mock.mockResolvedValueOnce([{ fact: 'User is a marine biologist', relevance: 0.61 }]);

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toContain('User is a marine biologist');
    expect(preamble).not.toContain('% relevant'); // framed as knowledge, not a scored list
    // V2 beliefs are not V1 mementos and carry no memento id to track.
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('gives a V2 user their memory in agent mode even with V1 switched OFF', async () => {
    // The regression this exists for: agent mode gated retrieval on `enableMementos` alone, so a user
    // who had moved to V2 ran completely un-personalized in agent mode while chat knew them fine. That
    // is also the precondition for ever deleting V1 - agent mode cannot depend on the V1 flag.
    recallMementosV2Mock.mockResolvedValueOnce([{ fact: 'User keeps a lathe in the woodshop', relevance: 0.63 }]);

    const { preamble } = await getFirstIterationMementosPreamble(
      makeExecution({ enableMementos: false }),
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toContain('User keeps a lathe in the woodshop');
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('stays silent for a V2 user whose memory has nothing relevant', async () => {
    recallMementosV2Mock.mockResolvedValueOnce([]);

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });
});
