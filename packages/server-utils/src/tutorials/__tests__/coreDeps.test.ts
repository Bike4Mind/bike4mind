// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasAutoNamePlaceholderName, TUTORIAL_SESSION_PREFIX } from '@bike4mind/common';
import { sessionRepository } from '@bike4mind/database';
import { getOrCreateSession } from '../../managers/sessionCrud';
import type { TutorialRequest } from '../routes/types';

const found = vi.hoisted(() => ({
  session: undefined as Record<string, unknown> | undefined,
  projects: [] as unknown[],
}));
const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  findFiles: vi.fn(),
  transaction: vi.fn(),
  rescope: vi.fn(),
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionRepository: { findByIdAndUserId: async () => found.session, update: vi.fn() },
  fabFileRepository: { find: mocks.findFiles },
  projectRepository: { findAllBySessionId: async () => found.projects },
  withTransaction: mocks.transaction,
}));
vi.mock('@bike4mind/services', () => ({ sessionService: { deleteSession: mocks.deleteSession } }));
vi.mock('../../websocket/rescopeUserSubscriptions', () => ({ rescopeUserSubscriptions: mocks.rescope }));
vi.mock('../../managers/sessionCrud', () => ({ getOrCreateSession: vi.fn() }));
vi.mock('../sheet', () => ({ tutorialSheets: () => ({}) }));

import { coreTutorialDepsFor } from '../coreDeps';

const ownsSession = coreTutorialDepsFor({} as unknown as TutorialRequest).ownsSession;

describe('ownsSession', () => {
  it('owns a main-surface session of the user', async () => {
    found.session = { id: 's1', name: 'Tutorial: x' };
    expect(await ownsSession('s1', 'u1')).toBe(true);
  });

  it('does not own a session the user lacks', async () => {
    found.session = undefined;
    expect(await ownsSession('s1', 'u1')).toBe(false);
  });

  it('does not own a session moved into a workspace', async () => {
    found.session = { id: 's1', name: 'Tutorial: x', surface: 'quest' };
    expect(await ownsSession('s1', 'u1')).toBe(false);
  });
});

describe('tutorial notebook deletion', () => {
  const logger = { warn: vi.fn() };
  const deps = () => coreTutorialDepsFor({ logger } as unknown as TutorialRequest);
  beforeEach(() => {
    vi.clearAllMocks();
    found.session = { id: 's1', name: `${TUTORIAL_SESSION_PREFIX}Walkthrough` };
    mocks.findFiles.mockReset().mockResolvedValue([]);
    mocks.deleteSession.mockReset().mockResolvedValue(null);
    mocks.transaction.mockReset().mockImplementation(async (change: () => Promise<unknown>) => change());
    mocks.rescope.mockReset().mockResolvedValue(undefined);
  });

  it('invalidates the actual affected users after commit', async () => {
    const trace: string[] = [];
    mocks.deleteSession.mockImplementation(
      async (_userId: string, _params: unknown, adapters: { onAccessRemoved: (ids: string[]) => void }) => {
        trace.push('delete');
        adapters.onAccessRemoved(['collaborator']);
        return null;
      }
    );
    mocks.transaction.mockImplementation(async (change: () => Promise<unknown>) => {
      const result = await change();
      trace.push('commit');
      return result;
    });
    mocks.rescope.mockImplementation(async () => {
      trace.push('invalidate');
    });

    expect(await deps().deleteSession('s1', 'owner')).toBe(true);
    expect(trace).toEqual(['delete', 'commit', 'invalidate']);
    expect(mocks.rescope).toHaveBeenCalledWith(['collaborator'], logger);
  });

  it('publishes only the successful transaction attempt', async () => {
    let attempt = 0;
    mocks.deleteSession.mockImplementation(
      async (_userId: string, _params: unknown, adapters: { onAccessRemoved: (ids: string[]) => void }) => {
        adapters.onAccessRemoved([attempt++ === 0 ? 'aborted' : 'committed']);
        return null;
      }
    );
    mocks.transaction.mockImplementation(async (change: () => Promise<unknown>) => {
      await change();
      return change();
    });

    await deps().deleteSession('s1', 'owner');
    expect(mocks.rescope.mock.calls).toEqual([[['committed'], logger]]);
  });

  it('does not invalidate on rollback', async () => {
    mocks.transaction.mockImplementation(async (change: () => Promise<unknown>) => {
      await change();
      throw new Error('rollback');
    });
    await expect(deps().deleteSession('s1', 'owner')).rejects.toThrow('rollback');
    expect(mocks.rescope).not.toHaveBeenCalled();
  });

  it('keeps unowned, renamed and uploaded notebooks', async () => {
    found.session = undefined;
    expect(await deps().deleteSession('s1', 'owner')).toBe(false);
    found.session = { id: 's1', name: 'Notes' };
    expect(await deps().deleteSession('s1', 'owner')).toBe(false);
    found.session = { id: 's1', name: `${TUTORIAL_SESSION_PREFIX}Walkthrough` };
    mocks.findFiles.mockResolvedValue([{}]);
    expect(await deps().deleteSession('s1', 'owner')).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rescope).not.toHaveBeenCalled();
  });
});

describe('createSession', () => {
  it('names the notebook after the tutorial and leaves it out of auto-naming', async () => {
    const session = { id: 's1', name: 'Tutorial: First steps' } as Record<string, unknown>;
    vi.mocked(getOrCreateSession).mockResolvedValue({
      session,
      sessionId: 's1',
      asyncPromises: [],
    } as unknown as Awaited<ReturnType<typeof getOrCreateSession>>);
    vi.mocked(sessionRepository.update).mockImplementation(async update => {
      Object.assign(session, update);
      return session as never;
    });
    const deps = coreTutorialDepsFor({ user: { id: 'u1' }, logger: { warn: vi.fn() } } as unknown as TutorialRequest);

    await deps.createSession({ id: 'first-steps', title: 'First steps' } as never);

    expect(vi.mocked(getOrCreateSession).mock.calls[0][0]).toMatchObject({ sessionName: 'Tutorial: First steps' });
    expect(hasAutoNamePlaceholderName(session as { name: string; autoNamePlaceholder?: string })).toBe(false);
  });
});

describe('deleteSession', () => {
  const deleteSession = coreTutorialDepsFor({ logger: { warn: vi.fn() } } as unknown as TutorialRequest).deleteSession;
  const untouched = { id: 's1', name: 'Tutorial: First steps', users: [], groups: [], knowledgeIds: [] };

  beforeEach(() => {
    mocks.deleteSession.mockReset().mockResolvedValue(null);
    mocks.transaction.mockReset().mockImplementation(async (change: () => Promise<unknown>) => change());
    mocks.rescope.mockReset().mockResolvedValue(undefined);
  });

  const deletes = async (session: Record<string, unknown>, files: unknown[] = [], projects: unknown[] = []) => {
    found.session = session;
    found.projects = projects;
    mocks.findFiles.mockReset().mockResolvedValue(files);
    const result = await deleteSession('s1', 'u1');
    expect(mocks.deleteSession).toHaveBeenCalledTimes(result ? 1 : 0);
    return result;
  };

  it('deletes an untouched tutorial notebook', async () => {
    expect(await deletes(untouched)).toBe(true);
  });

  it.each([
    ['renamed', { ...untouched, name: 'My heater email' }],
    ['shared with a user', { ...untouched, users: [{ userId: 'u2', permissions: ['read'] }] }],
    ['shared with a group', { ...untouched, groups: [{ groupId: 'g1', permissions: ['read'] }] }],
    ['shared by link', { ...untouched, isGlobalRead: true }],
    ['given knowledge', { ...untouched, knowledgeIds: ['f1'] }],
  ])('keeps a notebook the user %s', async (_label, session) => {
    expect(await deletes(session)).toBe(false);
  });

  it('keeps a notebook the user uploaded to', async () => {
    expect(await deletes(untouched, [{ id: 'f1' }])).toBe(false);
  });

  it('keeps a notebook the user put in a project', async () => {
    expect(await deletes(untouched, [], [{ id: 'p1' }])).toBe(false);
  });
});
