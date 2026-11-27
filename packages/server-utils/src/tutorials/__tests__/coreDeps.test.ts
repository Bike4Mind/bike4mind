// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TUTORIAL_SESSION_PREFIX } from '@bike4mind/common';
import type { TutorialRequest } from '../routes/types';

const found = vi.hoisted(() => ({ session: undefined as Record<string, unknown> | undefined }));
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
