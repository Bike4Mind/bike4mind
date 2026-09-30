import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Permission } from '@bike4mind/common';
import { getOrCreateNotebookForSlackUser } from './notebook-manager';

const mockFindById = vi.fn();
const mockFindOne = vi.fn();
const mockCreateSession = vi.fn();

vi.mock('../di/registry', () => ({
  getSlackDb: () => ({
    User: { findById: mockFindById },
    Session: { findOne: mockFindOne },
    defineAbilitiesFor: vi.fn().mockReturnValue({}),
    sessionRepository: {},
    projectRepository: {},
    fabFileRepository: {},
  }),
  getSlackDeps: () => ({
    sessionManager: { createSession: mockCreateSession, getDefaultSession: vi.fn().mockReturnValue({}) },
  }),
}));

vi.mock('@bike4mind/services', () => ({ projectService: { addSessions: vi.fn() } }));

vi.mock('@bike4mind/observability', () => ({
  Logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const USER_ID = 'user-1';
const OWNED = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OWNED_2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FOREIGN = 'cccccccccccccccccccccccc';
const SHARED_UPDATE = 'dddddddddddddddddddddddd';
const SHARED_READ = 'eeeeeeeeeeeeeeeeeeeeeeee';
const DELETED = 'ffffffffffffffffffffffff';
const CREATED = '111111111111111111111111';

// Deleted notebooks are absent: the real query filters them via deletedAt, asserted below.
const docsById: Record<string, object> = {
  [OWNED]: { id: OWNED, userId: USER_ID },
  [OWNED_2]: { id: OWNED_2, userId: USER_ID },
  [FOREIGN]: { id: FOREIGN, userId: 'someone-else' },
  [SHARED_UPDATE]: {
    id: SHARED_UPDATE,
    userId: 'someone-else',
    users: [{ userId: USER_ID, permissions: [Permission.read, Permission.update] }],
  },
  [SHARED_READ]: {
    id: SHARED_READ,
    userId: 'someone-else',
    users: [{ userId: USER_ID, permissions: [Permission.read] }],
  },
};

function withUser(slackSettings: object, lastNotebookId?: string) {
  mockFindById.mockResolvedValue({ id: USER_ID, slackSettings, lastNotebookId });
}

// Empty channelId skips PRIORITY 2 so the saved-id fallbacks are reached.
const resolve = (agentName?: string) =>
  getOrCreateNotebookForSlackUser(USER_ID, 'U1', 'hello', '', undefined, agentName);

describe('getOrCreateNotebookForSlackUser saved notebook ids', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOne.mockImplementation(async ({ _id }: { _id: string }) => docsById[_id] ?? null);
    mockCreateSession.mockResolvedValue({ id: CREATED });
  });

  it('returns an owned defaultNotebookId', async () => {
    withUser({ defaultNotebookId: OWNED });
    expect(await resolve()).toBe(OWNED);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('falls through a foreign agentNotebookRouting id to the default notebook', async () => {
    withUser({ agentNotebookRouting: { bot: FOREIGN }, defaultNotebookId: OWNED });
    expect(await resolve('bot')).toBe(OWNED);
  });

  it('returns an owned agentNotebookRouting id', async () => {
    withUser({ agentNotebookRouting: { bot: OWNED_2 }, defaultNotebookId: OWNED });
    expect(await resolve('bot')).toBe(OWNED_2);
  });

  it('returns a keyword-routed notebook shared with update permission', async () => {
    withUser({ keywordRouting: [{ keywords: ['hello'], notebookId: SHARED_UPDATE }], defaultNotebookId: OWNED });
    expect(await resolve()).toBe(SHARED_UPDATE);
  });

  it('falls through a foreign keyword-routed notebook to the default notebook', async () => {
    withUser({ keywordRouting: [{ keywords: ['hello'], notebookId: FOREIGN }], defaultNotebookId: OWNED });
    expect(await resolve()).toBe(OWNED);
  });

  it('falls through a foreign defaultNotebookId to lastNotebookId', async () => {
    withUser({ defaultNotebookId: FOREIGN }, OWNED);
    expect(await resolve()).toBe(OWNED);
  });

  it('falls through a foreign lastNotebookId to creating a notebook', async () => {
    withUser({}, FOREIGN);
    expect(await resolve()).toBe(CREATED);
    expect(mockCreateSession).toHaveBeenCalledOnce();
  });

  it('returns a lastNotebookId shared with update permission', async () => {
    withUser({}, SHARED_UPDATE);
    expect(await resolve()).toBe(SHARED_UPDATE);
  });

  it('falls through a read-only shared notebook', async () => {
    withUser({}, SHARED_READ);
    expect(await resolve()).toBe(CREATED);
  });

  it('falls through a deleted notebook and filters deleted docs in the query', async () => {
    withUser({ defaultNotebookId: DELETED });
    expect(await resolve()).toBe(CREATED);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: DELETED, deletedAt: { $exists: false } });
  });

  it('falls through a malformed id without querying', async () => {
    withUser({ defaultNotebookId: 'not-an-object-id' });
    expect(await resolve()).toBe(CREATED);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('falls through when the lookup throws', async () => {
    mockFindOne.mockRejectedValue(new Error('db down'));
    withUser({ defaultNotebookId: OWNED });
    expect(await resolve()).toBe(CREATED);
  });
});
