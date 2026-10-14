import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, WORKSPACE_SURFACES, type SurfaceAccessUser } from '@bike4mind/common';
import { cloneSession } from './clone';
import { forkSession } from './fork';
import { snipSession } from './snip';
import { resolveCopySurface } from './surfaceTransition';

/**
 * Copy grants (`SurfaceAccessUser.copyEntitlements`) on the server path every fork, snip and clone
 * shares: a session copied inside an entitlement-gated workspace stays there for a holder of the
 * workspace's own entitlement OR of a key the grant table lists for it, and falls back to the main
 * list for anyone else. The grant never stretches to an explicit target, which stays a transition.
 *
 * The gated workspace is found by shape rather than by name, so these cases follow whichever one the
 * registry carries.
 */
const gated = WORKSPACE_SURFACES.find(surface => surface.id !== null && surface.requiredEntitlement !== null);
if (!gated?.id || !gated.requiredEntitlement) throw new Error('expected an entitlement-gated workspace');
const GATED = gated.id;
const REQUIRED = gated.requiredEntitlement;
const GRANTED = 'questmaster:pro';
const copyEntitlements = { [GATED]: [GRANTED] };

const access = (user: SurfaceAccessUser) => async () => user;
const grantHolder = access({ entitlements: [GRANTED], copyEntitlements });
const requiredHolder = access({ entitlements: [REQUIRED], copyEntitlements });
const neither = access({ entitlements: ['some-other:pro'], copyEntitlements });

const sourceSession = {
  id: 'session-1',
  userId: 'caller-1',
  name: 'Original',
  knowledgeIds: [],
  tags: [],
  surface: GATED,
};

function forkAdapters() {
  return {
    db: {
      users: { findById: vi.fn().mockResolvedValue({ id: 'caller-1' }) },
      sessions: {
        findByIdAndUserId: vi.fn().mockResolvedValue(sourceSession),
        create: vi.fn().mockResolvedValue({ id: 'copy-1' }),
      },
      projects: {},
      fabFiles: {},
      chatHistories: {
        findBySessionIdAndId: vi.fn().mockResolvedValue({ id: 'm1', timestamp: new Date(10) }),
        findAllBySessionIdAndLessThanOrEqualToTimestamp: vi.fn().mockResolvedValue([]),
        findAllBySessionIdAndGreaterThanOrEqualToTimestamp: vi.fn().mockResolvedValue([]),
        create: vi.fn(async chat => ({ id: 'new-msg-1', ...chat })),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
    } as any,
  };
}

function cloneAdapters() {
  return {
    db: {
      users: { findById: vi.fn().mockResolvedValue({ id: 'caller-1' }) },
      sessions: {
        shareable: { findAccessibleById: vi.fn().mockResolvedValue({ ...sourceSession, userId: 'owner-1' }) },
        create: vi.fn().mockResolvedValue({ id: 'copy-1' }),
      },
      projects: {},
      fabFiles: {
        shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue([]) },
        search: vi.fn().mockResolvedValue({ data: [] }),
        findAccessibleInIds: vi.fn().mockResolvedValue([]),
      },
      chatHistories: {
        findAllBySessionId: vi.fn().mockResolvedValue([]),
        create: vi.fn(async chat => ({ id: 'new-msg-1', ...chat })),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
    } as any,
  };
}

const copies = {
  fork: async (resolveSurfaceAccess: () => Promise<SurfaceAccessUser>) => {
    const { db } = forkAdapters();
    await forkSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db, resolveSurfaceAccess });
    return db.sessions.create.mock.calls[0][0].surface;
  },
  snip: async (resolveSurfaceAccess: () => Promise<SurfaceAccessUser>) => {
    const { db } = forkAdapters();
    await snipSession('caller-1', { sessionId: 'session-1', messageId: 'm1' }, { db, resolveSurfaceAccess });
    return db.sessions.create.mock.calls[0][0].surface;
  },
  // A share holder (the session's owner is someone else): clone is the copy a non-owner can make.
  clone: async (resolveSurfaceAccess: () => Promise<SurfaceAccessUser>) => {
    const { db } = cloneAdapters();
    await cloneSession('caller-1', { id: 'session-1' }, { db, resolveSurfaceAccess });
    return db.sessions.create.mock.calls[0][0].surface;
  },
};

describe.each(Object.entries(copies))('%s inside an entitlement-gated workspace', (_name, copy) => {
  it('keeps the copy in the workspace for a holder of a granted key', async () => {
    expect(await copy(grantHolder)).toBe(GATED);
  });

  it('keeps the copy in the workspace for a holder of its own entitlement', async () => {
    expect(await copy(requiredHolder)).toBe(GATED);
  });

  it('lands the copy in the main list for a user with neither', async () => {
    expect(await copy(neither)).toBeUndefined();
  });

  it('lands the copy in the main list when the granted key comes with no grant table', async () => {
    expect(await copy(access({ entitlements: [GRANTED] }))).toBeUndefined();
  });
});

describe('resolveCopySurface with copy grants', () => {
  it('refuses an explicit target to a grant-only holder, since a target is a transition', async () => {
    await expect(resolveCopySurface(GATED, GATED, grantHolder)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resolveCopySurface(null, GATED, grantHolder)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('ignores a grant listed for a different workspace', async () => {
    const elsewhere = access({ entitlements: [GRANTED], copyEntitlements: { 'some-other-surface': [GRANTED] } });
    expect(await resolveCopySurface(GATED, undefined, elsewhere)).toBeUndefined();
  });

  it('falls back to the main list when no access resolver is supplied', async () => {
    expect(await resolveCopySurface(GATED, undefined, undefined)).toBeUndefined();
  });
});
