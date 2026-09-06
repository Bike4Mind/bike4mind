import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveRetrievalLakeScopeForUser = vi.fn();
const lakeMembershipsFrom = vi.fn();
const warnIfManyLakeMemberships = vi.fn();

vi.mock('@server/dataLakes/resolveRetrievalLakeScope', () => ({
  resolveRetrievalLakeScopeForUser: (...args: unknown[]) => resolveRetrievalLakeScopeForUser(...args),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    lakeMembershipsFrom: (...args: unknown[]) => lakeMembershipsFrom(...args),
    warnIfManyLakeMemberships: (...args: unknown[]) => warnIfManyLakeMemberships(...args),
  },
}));

import { createAttachmentLakeAccess } from './agentExecutor.attachmentLakeAccess';

const MEMBERSHIP = {
  kind: 'owned' as const,
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  creatorUserId: 'creator-1',
};

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() });
const USER = { id: 'u1', tags: [] } as never;

describe('createAttachmentLakeAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lakeMembershipsFrom.mockReturnValue([MEMBERSHIP]);
  });

  it('opts out of the privileged static-registry bypass', async () => {
    resolveRetrievalLakeScopeForUser.mockResolvedValue({ lakes: [], dataLakeTags: [], dataLakeTagPrefixes: [] });
    const logger = makeLogger();

    await createAttachmentLakeAccess(USER, logger as never)();

    expect(resolveRetrievalLakeScopeForUser).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ staticRegistryBypass: false })
    );
  });

  it('derives lakeMemberships through lakeMembershipsFrom and forwards the tag buckets verbatim', async () => {
    resolveRetrievalLakeScopeForUser.mockResolvedValue({
      lakes: [{ id: 'l1' }],
      dataLakeTags: ['datalake:acme'],
      dataLakeTagPrefixes: ['reg:'],
    });
    const logger = makeLogger();

    const access = await createAttachmentLakeAccess(USER, logger as never)();

    expect(lakeMembershipsFrom).toHaveBeenCalledWith([{ id: 'l1' }]);
    expect(access).toEqual({
      lakeMemberships: [MEMBERSHIP],
      dataLakeTags: ['datalake:acme'],
      dataLakeTagPrefixes: ['reg:'],
    });
  });

  // The load-bearing one: this resolver has no fail-safe of its own, so without the catch an
  // unhandled rejection fails the whole agent run instead of degrading to ownership-only.
  it('degrades to ownership-only when the resolver throws, and never widens', async () => {
    resolveRetrievalLakeScopeForUser.mockRejectedValue(new Error('lake read failed'));
    const logger = makeLogger();

    const access = await createAttachmentLakeAccess(USER, logger as never)();

    // {} means "no lake arms" downstream - byte-identical to the pre-#1576 ownership-only query.
    expect(access).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      '[AttachmentLakeAccess] Resolution failed; falling back to ownership-only',
      expect.objectContaining({ error: 'lake read failed' })
    );
  });

  it('rejecting once does not poison later calls into an unhandled rejection', async () => {
    resolveRetrievalLakeScopeForUser.mockRejectedValue(new Error('lake read failed'));
    const thunk = createAttachmentLakeAccess(USER, makeLogger() as never);

    await expect(thunk()).resolves.toEqual({});
    await expect(thunk()).resolves.toEqual({});
  });

  it('memoizes: the resolver runs once however many times the thunk is called', async () => {
    resolveRetrievalLakeScopeForUser.mockResolvedValue({ lakes: [], dataLakeTags: [], dataLakeTagPrefixes: [] });
    const thunk = createAttachmentLakeAccess(USER, makeLogger() as never);

    await Promise.all([thunk(), thunk(), thunk()]);

    expect(resolveRetrievalLakeScopeForUser).toHaveBeenCalledTimes(1);
  });

  it('is lazy: constructing the thunk resolves nothing', () => {
    resolveRetrievalLakeScopeForUser.mockResolvedValue({ lakes: [], dataLakeTags: [], dataLakeTagPrefixes: [] });

    createAttachmentLakeAccess(USER, makeLogger() as never);

    expect(resolveRetrievalLakeScopeForUser).not.toHaveBeenCalled();
  });
});
