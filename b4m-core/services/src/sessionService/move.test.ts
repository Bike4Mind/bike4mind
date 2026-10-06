import { describe, it, expect, vi } from 'vitest';
import { BadRequestError, ForbiddenError, OPTI_SURFACE } from '@bike4mind/common';
import { moveSession } from './move';

const OPTI_ACCESS = async () => ({ isAdmin: false, tags: [], entitlements: ['optihashi:pro'] });
const NO_ACCESS = async () => ({ isAdmin: false, tags: [], entitlements: [] });

const makeAdapters = (session: Record<string, unknown> | null, resolveSurfaceAccess = OPTI_ACCESS) => {
  const sessions = {
    findByIdAndUserId: vi.fn().mockResolvedValue(session),
    update: vi.fn(async (data: Record<string, unknown>) => ({ ...session, ...data })),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
  return { db: { sessions } as any, resolveSurfaceAccess, sessions };
};

describe('moveSession', () => {
  it('moves a main-list session into opti for an entitled owner', async () => {
    const { sessions, ...adapters } = makeAdapters({ id: 's1', userId: 'u1' });

    const result = await moveSession('u1', { id: 's1', targetSurface: OPTI_SURFACE }, adapters);

    expect(sessions.findByIdAndUserId).toHaveBeenCalledWith('s1', 'u1');
    expect(sessions.update).toHaveBeenCalledWith({ id: 's1', surface: OPTI_SURFACE });
    expect(result.surface).toBe(OPTI_SURFACE);
  });

  // The main list is "no surface", so the field is removed rather than written as null.
  it('unsets surface when moving back to the main list', async () => {
    const { sessions, ...adapters } = makeAdapters({ id: 's1', userId: 'u1', surface: OPTI_SURFACE }, NO_ACCESS);

    await moveSession('u1', { id: 's1', targetSurface: null }, adapters);

    expect(sessions.update).toHaveBeenCalledWith({ id: 's1' }, { unset: ['surface'] });
  });

  it('writes nothing when the session is already in the target workspace', async () => {
    const { sessions, ...adapters } = makeAdapters({ id: 's1', userId: 'u1', surface: OPTI_SURFACE });

    await moveSession('u1', { id: 's1', targetSurface: OPTI_SURFACE }, adapters);

    expect(sessions.update).not.toHaveBeenCalled();
  });

  // findByIdAndUserId scopes the read to the caller, so a share holder's request reads nothing.
  it('404s a session the caller does not own', async () => {
    const { sessions, ...adapters } = makeAdapters(null);

    await expect(moveSession('u2', { id: 's1', targetSurface: OPTI_SURFACE }, adapters)).rejects.toThrow(
      'Session not found'
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('403s a destination the caller is not entitled to', async () => {
    const { sessions, ...adapters } = makeAdapters({ id: 's1', userId: 'u1' }, NO_ACCESS);

    await expect(moveSession('u1', { id: 's1', targetSurface: OPTI_SURFACE }, adapters)).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('400s an unregistered destination', async () => {
    const { sessions, ...adapters } = makeAdapters({ id: 's1', userId: 'u1' });

    await expect(
      moveSession('u1', { id: 's1', targetSurface: 'some-private-surface' }, adapters)
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('400s moving a session out of a surface this repo does not register', async () => {
    const { sessions, ...adapters } = makeAdapters({ id: 's1', userId: 'u1', surface: 'some-private-surface' });

    await expect(moveSession('u1', { id: 's1', targetSurface: null }, adapters)).rejects.toBeInstanceOf(
      BadRequestError
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('fails closed with a 403 when no access resolver is supplied', async () => {
    const { sessions, db } = makeAdapters({ id: 's1', userId: 'u1' });

    await expect(moveSession('u1', { id: 's1', targetSurface: OPTI_SURFACE }, { db })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(sessions.update).not.toHaveBeenCalled();
  });
});
