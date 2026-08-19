import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { MementoGates } from '@bike4mind/services';
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

const recallMementosV2Mock =
  vi.fn<(...args: unknown[]) => Promise<Array<{ fact: string; relevance: number }> | null>>();

vi.mock('@server/memory/recallMementosV2', () => ({
  recallMementosV2: (...args: unknown[]) => recallMementosV2Mock(...args),
}));

const makeExecution = (overrides: Partial<MementoRetrievalExecution> = {}): MementoRetrievalExecution => ({
  id: 'exec-1',
  userId: 'user-1',
  query: 'what hobbies do I have',
  ...overrides,
});

/** V1-only user: request flag `true` + admin on, no V2 opt-in. */
const V1_ONLY: MementoGates = { v1: true, v2: false };
/** V2-only user: request flag `undefined`, V2 opted in. */
const V2_ONLY: MementoGates = { v1: false, v2: true };
/** Explicit per-request opt-out from a V2-opted user (#1337): both pipelines off. */
const OPTED_OUT: MementoGates = { v1: false, v2: false };

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
    recallMementosV2Mock.mockResolvedValue([]);
  });

  it('returns a formatted preamble and mementoIds on the happy path (V1)', async () => {
    getRelevantMementosMock.mockResolvedValueOnce([
      { memento: { id: 'm1', summary: 'User enjoys playing chess on Saturdays' }, similarity: 0.92 },
      { memento: { id: 'm2', summary: 'User prefers TypeScript over JavaScript' }, similarity: 0.81 },
    ]);
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      V1_ONLY,
      makeAdapters(),
      logger
    );

    expect(getRelevantMementosMock).toHaveBeenCalledTimes(1);
    // The V1 path matches MementoFeature's chat-path params (topK 10, minSimilarity 0.75) so agent-mode
    // and chat-mode pull the same set.
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

  it('reads NEITHER pipeline when both gates are off - the per-request opt-out (#1337)', async () => {
    // A V2-opted user who sent `enableMementos: false` resolves to { v1: false, v2: false }. Before
    // #1337 the agent read side ran V2 recall unconditionally, injecting beliefs the user opted out of.
    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      OPTED_OUT,
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(recallMementosV2Mock).not.toHaveBeenCalled();
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('returns empty preamble and empty mementoIds when parentExecutionId is set (subagent / DAG child)', async () => {
    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution({ parentExecutionId: 'parent-exec-99' }),
      V1_ONLY,
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(recallMementosV2Mock).not.toHaveBeenCalled();
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('returns empty preamble for a BACKGROUND subagent, which sets spawnedByExecutionId and NO parentExecutionId', async () => {
    // Read-side half of the #1337 background-child leak. `V2_ONLY` on purpose: a background child of an
    // opted-out parent resolves V2 back on (its own `enableMementos` is undefined), so the gates cannot
    // be what stops it - only the lineage check can.
    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution({ spawnedByExecutionId: 'spawner-exec-42' }),
      V2_ONLY,
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(recallMementosV2Mock).not.toHaveBeenCalled();
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('returns empty preamble and empty mementoIds when no V1 mementos clear the similarity threshold', async () => {
    getRelevantMementosMock.mockResolvedValueOnce([]);
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      V1_ONLY,
      makeAdapters(),
      logger
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith('[Mementos] No relevant mementos found for first iteration', {
      executionId: 'exec-1',
    });
  });

  it('swallows retrieval errors, warn-logs, and returns empty preamble and empty mementoIds', async () => {
    getRelevantMementosMock.mockRejectedValueOnce(new Error('embedding API down'));
    const logger = makeLogger();

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      V1_ONLY,
      makeAdapters(),
      logger
    );

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

    const { preamble } = await getFirstIterationMementosPreamble(
      makeExecution(),
      V1_ONLY,
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toContain('User likes chess and tennis');
    expect(preamble).not.toContain('User likes\nchess');
    expect(preamble).not.toContain('chess\rand');
  });

  it('serves a V2 user from the ledger and never touches the V1 path', async () => {
    recallMementosV2Mock.mockResolvedValueOnce([{ fact: 'User is a marine biologist', relevance: 0.61 }]);

    const { preamble, mementoIds } = await getFirstIterationMementosPreamble(
      makeExecution(),
      V2_ONLY,
      makeAdapters(),
      makeLogger()
    );

    // The resolved opt-in is handed to recall so it does not re-look-it-up.
    expect(recallMementosV2Mock).toHaveBeenCalledWith('user-1', 'what hobbies do I have', { enabled: true });
    expect(preamble).toContain('User is a marine biologist');
    expect(preamble).not.toContain('% relevant'); // framed as knowledge, not a scored list
    // V2 beliefs are not V1 mementos and carry no memento id to track.
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });

  it('gives a V2 user their memory in agent mode even with V1 switched OFF', async () => {
    // A V2-only user sends `enableMementos: undefined`, which resolves to { v1: false, v2: true } - V2
    // still reads even though V1 is off. (This is distinct from the explicit `false` opt-out above.)
    recallMementosV2Mock.mockResolvedValueOnce([{ fact: 'User keeps a lathe in the woodshop', relevance: 0.63 }]);

    const { preamble } = await getFirstIterationMementosPreamble(
      makeExecution(),
      V2_ONLY,
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
      V2_ONLY,
      makeAdapters(),
      makeLogger()
    );

    expect(preamble).toBe('');
    expect(mementoIds).toEqual([]);
    expect(getRelevantMementosMock).not.toHaveBeenCalled();
  });
});
