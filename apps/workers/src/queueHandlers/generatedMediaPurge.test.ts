import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  deletedIds: [] as string[],
  sessionFilter: undefined as unknown,
  sessionResult: undefined as { leftoverSessionIds: string[]; leftoverKeys: string[] } | undefined,
  runPurge: vi.fn(),
  deleteGenerated: vi.fn(),
  cdnSend: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  Session: {
    find: (filter: unknown) => {
      h.sessionFilter = filter;
      return { setOptions: () => ({ lean: async () => h.deletedIds.map(_id => ({ _id })) }) };
    },
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: h.deleteGenerated }),
}));
vi.mock('@server/services/cdn/invalidateRouterCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/services/cdn/invalidateRouterCdn')>()),
  createCdnInvalidationBatch: () => {
    const paths: string[] = [];
    return { add: (path: string) => paths.push(path), flush: async () => h.cdnSend(paths) };
  },
}));
vi.mock('@server/sessions/generatedMediaPurgeQueue', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/sessions/generatedMediaPurgeQueue')>()),
  enqueueGeneratedMediaPurge: h.enqueue,
}));
// Keys messages run the real purge (storage and CDN mocked); notebook lookups are stubbed.
vi.mock('@server/sessions/purgeDeletedNotebookMedia', async importOriginal => {
  const real = await importOriginal<typeof import('@server/sessions/purgeDeletedNotebookMedia')>();
  return {
    ...real,
    runGeneratedMediaPurge: (...args: Parameters<typeof real.runGeneratedMediaPurge>) => {
      h.runPurge(...args);
      return args[0].sessionIds ? Promise.resolve(h.sessionResult) : real.runGeneratedMediaPurge(...args);
    },
  };
});

import { dispatch, WORKER_PURGE_BUDGET_MS } from './generatedMediaPurge';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const run = (body: unknown) =>
  dispatch(
    { Records: [{ body: typeof body === 'string' ? body : JSON.stringify(body) }] } as never,
    {} as never,
    logger
  );
const LIVE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DEAD = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DEAD2 = 'cccccccccccccccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
  h.deletedIds = [];
  h.sessionResult = { leftoverSessionIds: [], leftoverKeys: [] };
  h.deleteGenerated.mockResolvedValue(undefined);
  h.cdnSend.mockResolvedValue(undefined);
  h.enqueue.mockResolvedValue(true);
});

describe('generatedMediaPurge', () => {
  it('purges only notebooks that are soft-deleted and drops a live id', async () => {
    h.deletedIds = [DEAD];
    await run({ kind: 'sessions', sessionIds: [LIVE, DEAD] });
    expect(h.sessionFilter).toEqual({ _id: { $in: [LIVE, DEAD] }, deletedAt: { $ne: null } });
    expect(h.runPurge).toHaveBeenCalledTimes(1);
    const [input, options] = h.runPurge.mock.calls[0];
    expect(input).toEqual({ sessionIds: [DEAD] });
    expect([...options.deletedSessionIds]).toEqual([DEAD]);
    expect(options.deadline - Date.now()).toBeLessThanOrEqual(WORKER_PURGE_BUDGET_MS);
  });

  it('does not purge at all when every id is live', async () => {
    await run({ kind: 'sessions', sessionIds: [LIVE] });
    expect(h.runPurge).not.toHaveBeenCalled();
  });

  it('deletes and invalidates the keys of a keys message', async () => {
    await run({ kind: 'keys', keys: ['a.png', 'b.png'] });
    expect(h.deleteGenerated.mock.calls.map(([k]) => k).sort()).toEqual(['a.png', 'b.png']);
    expect(h.cdnSend).toHaveBeenCalledTimes(1);
    expect([...h.cdnSend.mock.calls[0][0]].sort()).toEqual(['/generated/a.png', '/generated/b.png']);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues what a run that made progress did not reach', async () => {
    h.deletedIds = [DEAD, DEAD2];
    h.sessionResult = { leftoverSessionIds: [DEAD2], leftoverKeys: ['k.png'] };
    await run({ kind: 'sessions', sessionIds: [DEAD, DEAD2] });
    expect(h.enqueue).toHaveBeenCalledWith({ sessionIds: [DEAD2], keys: ['k.png'] }, logger);
  });

  it('throws instead of re-enqueueing when a run made no progress', async () => {
    h.deletedIds = [DEAD];
    h.sessionResult = { leftoverSessionIds: [DEAD], leftoverKeys: [] };
    await expect(run({ kind: 'sessions', sessionIds: [DEAD] })).rejects.toThrow(/no progress/);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('throws when the re-enqueue fails so SQS retries the message', async () => {
    h.deletedIds = [DEAD, DEAD2];
    h.sessionResult = { leftoverSessionIds: [DEAD2], leftoverKeys: [] };
    h.enqueue.mockResolvedValue(false);
    await expect(run({ kind: 'sessions', sessionIds: [DEAD, DEAD2] })).rejects.toThrow(/re-enqueue/);
  });

  it('drops a malformed body, invalid JSON and a non-ObjectId session id without purging', async () => {
    await expect(run({ kind: 'sessions', sessionIds: [] })).resolves.toBeUndefined();
    await expect(run({ kind: 'keys', keys: [] })).resolves.toBeUndefined();
    await expect(run({ kind: 'sessions', sessionIds: [{ $ne: null }] })).resolves.toBeUndefined();
    await expect(run('{not json')).resolves.toBeUndefined();
    expect(h.runPurge).not.toHaveBeenCalled();
    expect(h.deleteGenerated).not.toHaveBeenCalled();
  });
});
