import { describe, expect, it } from 'vitest';
import {
  canUseSurface,
  checkSurfaceTransition,
  getWorkspaceSurface,
  normalizeSurfaceId,
  OPTI_SURFACE,
  WORKSPACE_SURFACES,
} from './surfaces';

const plainUser = { isAdmin: false, tags: [], entitlements: ['base'] };
const optiUser = { isAdmin: false, tags: [], entitlements: ['base', 'optihashi:pro'] };

describe('workspace surface registry', () => {
  it('registers exactly the main list and opti', () => {
    expect(WORKSPACE_SURFACES.map(surface => surface.id)).toEqual([null, OPTI_SURFACE]);
  });

  it('treats undefined, null and the empty string as the main list', () => {
    expect(normalizeSurfaceId(undefined)).toBeNull();
    expect(normalizeSurfaceId('')).toBeNull();
    expect(getWorkspaceSurface(undefined)?.id).toBeNull();
  });

  // Private surfaces keep their string out of this repo, so anything unregistered must be unknown.
  it('does not resolve a surface this repo does not register', () => {
    expect(getWorkspaceSurface('some-private-surface')).toBeUndefined();
  });

  it('builds the session URL for each workspace', () => {
    expect(getWorkspaceSurface(null)?.sessionHref('abc')).toBe('/notebooks/abc');
    expect(getWorkspaceSurface(OPTI_SURFACE)?.sessionHref('abc')).toBe('/opti?mode=canvas&session=abc');
  });
});

describe('canUseSurface', () => {
  it('lets every user use the main list', () => {
    expect(canUseSurface(plainUser, null)).toBe(true);
  });

  it('requires the opti entitlement, matched case-insensitively', () => {
    expect(canUseSurface(plainUser, OPTI_SURFACE)).toBe(false);
    expect(canUseSurface(optiUser, OPTI_SURFACE)).toBe(true);
    expect(canUseSurface({ entitlements: [' OptiHashi:Pro '] }, OPTI_SURFACE)).toBe(true);
  });

  it('lets admins and developers bypass the entitlement', () => {
    expect(canUseSurface({ isAdmin: true }, OPTI_SURFACE)).toBe(true);
    expect(canUseSurface({ tags: ['developer'] }, OPTI_SURFACE)).toBe(true);
  });

  it('denies an unregistered surface even to an admin, and denies a missing user', () => {
    expect(canUseSurface({ isAdmin: true }, 'some-private-surface')).toBe(false);
    expect(canUseSurface(null, null)).toBe(false);
  });
});

describe('checkSurfaceTransition', () => {
  it('allows an entitled user from the main list into opti and back', () => {
    expect(checkSurfaceTransition(optiUser, undefined, OPTI_SURFACE)).toEqual({ ok: true, target: OPTI_SURFACE });
    expect(checkSurfaceTransition(optiUser, OPTI_SURFACE, null)).toEqual({ ok: true, target: null });
  });

  it('lets a user who lost the entitlement still move a session out of opti', () => {
    expect(checkSurfaceTransition(plainUser, OPTI_SURFACE, null)).toEqual({ ok: true, target: null });
  });

  it('403s a destination the user is not entitled to', () => {
    expect(checkSurfaceTransition(plainUser, null, OPTI_SURFACE)).toMatchObject({ ok: false, status: 403 });
  });

  it('400s an unregistered destination', () => {
    expect(checkSurfaceTransition({ isAdmin: true }, null, 'some-private-surface')).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('400s a session whose surface is not registered, so it cannot be moved or copied out', () => {
    expect(checkSurfaceTransition({ isAdmin: true }, 'some-private-surface', null)).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
