import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  deletedIds: [] as string[],
  sessionFilter: undefined as unknown,
  sessionResult: undefined as { leftoverSessionIds: string[]; leftoverKeys: string[]; ownerIds: string[] } | undefined,
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
vi.mock('@bike4mind/server-utils/services/cdn/invalidateRouterCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/services/cdn/invalidateRouterCdn')>()),
  createCdnInvalidationBatch: () => {
    const paths: string[] = [];
    return { add: (path: string) => paths.push(path), flush: async () => h.cdnSend(paths) };
  },
}));
vi.mock('@server/sessions/generatedMediaPurgeQueue', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/sessions/generatedMediaPurgeQueue')>()),
  enqueueGeneratedMediaPurge: h.enqueue,
}));
// The purge itself (retention and ownership checks included) is covered by purgeDeletedNotebookMedia.e2e.test.ts.
vi.mock('@server/sessions/purgeDeletedNotebookMedia', async importOriginal => {
  const real = await importOriginal<typeof import('@server/sessions/purgeDeletedNotebookMedia')>();
  return {
    ...real,
    runGeneratedMediaPurge: (...args: Parameters<typeof real.runGeneratedMediaPurge>) => {
      h.runPurge(...args);
      return Promise.resolve(h.sessionResult);
    },
  };
});

const KEY_A = '00000000-0000-4000-8000-00000000000a.png';
const KEY_B = '00000000-0000-4000-8000-00000000000b.png';

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
  h.sessionResult = { leftoverSessionIds: [], leftoverKeys: [], ownerIds: [] };
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

  it('purges the keys of a keys message against the owners it carries', async () => {
    h.sessionResult = { leftoverSessionIds: [], leftoverKeys: [], ownerIds: ['u1'] };
    await run({ kind: 'keys', keys: [KEY_A, KEY_B], ownerIds: ['u1'] });
    expect(h.runPurge).toHaveBeenCalledWith(
      { keys: [KEY_A, KEY_B], ownerIds: ['u1'] },
      expect.objectContaining({ deletedSessionIds: new Set() })
    );
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('drops a keys message with a key outside the generated-content shape or no owners', async () => {
    await expect(run({ kind: 'keys', keys: ['../other/object'], ownerIds: ['u1'] })).resolves.toBeUndefined();
    await expect(run({ kind: 'keys', keys: ['avatars/u2.png'], ownerIds: ['u1'] })).resolves.toBeUndefined();
    await expect(run({ kind: 'keys', keys: [KEY_A] })).resolves.toBeUndefined();
    await expect(run({ kind: 'keys', keys: [KEY_A], ownerIds: [] })).resolves.toBeUndefined();
    expect(h.runPurge).not.toHaveBeenCalled();
  });

  it('re-enqueues what a run that made progress did not reach', async () => {
    h.deletedIds = [DEAD, DEAD2];
    h.sessionResult = { leftoverSessionIds: [DEAD2], leftoverKeys: [KEY_A], ownerIds: ['u1'] };
    await run({ kind: 'sessions', sessionIds: [DEAD, DEAD2] });
    expect(h.enqueue).toHaveBeenCalledWith({ sessionIds: [DEAD2], keys: [KEY_A], ownerIds: ['u1'] }, logger);
  });

  it('throws instead of re-enqueueing when a run made no progress', async () => {
    h.deletedIds = [DEAD];
    h.sessionResult = { leftoverSessionIds: [DEAD], leftoverKeys: [], ownerIds: [] };
    await expect(run({ kind: 'sessions', sessionIds: [DEAD] })).rejects.toThrow(/no progress/);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('throws for a keys message when no key was deleted, and re-enqueues once one was', async () => {
    h.sessionResult = { leftoverSessionIds: [], leftoverKeys: [KEY_A, KEY_B], ownerIds: ['u1'] };
    await expect(run({ kind: 'keys', keys: [KEY_A, KEY_B], ownerIds: ['u1'] })).rejects.toThrow(/no progress/);
    expect(h.enqueue).not.toHaveBeenCalled();

    h.sessionResult = { leftoverSessionIds: [], leftoverKeys: [KEY_B], ownerIds: ['u1'] };
    await run({ kind: 'keys', keys: [KEY_A, KEY_B], ownerIds: ['u1'] });
    expect(h.enqueue).toHaveBeenCalledWith({ sessionIds: [], keys: [KEY_B], ownerIds: ['u1'] }, logger);
  });

  it('throws when the re-enqueue fails so SQS retries the message', async () => {
    h.deletedIds = [DEAD, DEAD2];
    h.sessionResult = { leftoverSessionIds: [DEAD2], leftoverKeys: [], ownerIds: [] };
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
