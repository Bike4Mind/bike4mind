import { describe, expect, it } from 'vitest';
import { canCopyWithinSurface, canUseSurface, checkSurfaceTransition, WORKSPACE_SURFACES } from './surfaces';

/**
 * The gated workspace is found by shape rather than by name, so these cases follow whichever
 * entitlement-gated workspace the registry carries.
 */
const gated = WORKSPACE_SURFACES.find(surface => surface.id !== null && surface.requiredEntitlement !== null);
if (!gated?.id || !gated.requiredEntitlement) throw new Error('expected an entitlement-gated workspace');
const GATED = gated.id;
const REQUIRED = gated.requiredEntitlement;
const GRANTED = 'questmaster:pro';
const copyEntitlements = { [GATED]: [GRANTED] };

const grantHolder = { entitlements: [GRANTED], copyEntitlements };

describe('canCopyWithinSurface', () => {
  it('admits a holder of a key the grant table lists for the workspace', () => {
    expect(canCopyWithinSurface(grantHolder, GATED)).toBe(true);
  });

  it("admits a holder of the workspace's own entitlement, with or without a grant table", () => {
    expect(canCopyWithinSurface({ entitlements: [REQUIRED], copyEntitlements }, GATED)).toBe(true);
    expect(canCopyWithinSurface({ entitlements: [REQUIRED] }, GATED)).toBe(true);
  });

  it('admits admins and developers, as canUseSurface does', () => {
    expect(canCopyWithinSurface({ isAdmin: true }, GATED)).toBe(true);
    expect(canCopyWithinSurface({ tags: ['developer'] }, GATED)).toBe(true);
  });

  it('denies a user with neither the entitlement nor a granted key', () => {
    expect(canCopyWithinSurface({ entitlements: [], copyEntitlements }, GATED)).toBe(false);
    expect(canCopyWithinSurface({ entitlements: ['some-other:pro'], copyEntitlements }, GATED)).toBe(false);
    expect(canCopyWithinSurface(null, GATED)).toBe(false);
  });

  it('denies a granted key when the host supplies no grant table', () => {
    expect(canCopyWithinSurface({ entitlements: [GRANTED] }, GATED)).toBe(false);
    expect(canCopyWithinSurface({ entitlements: [GRANTED], copyEntitlements: {} }, GATED)).toBe(false);
  });

  it('scopes a grant to the workspace it is listed for', () => {
    const elsewhere = { entitlements: [GRANTED], copyEntitlements: { 'some-other-surface': [GRANTED] } };
    expect(canCopyWithinSurface(elsewhere, GATED)).toBe(false);
  });

  it('never makes an unregistered surface copyable, even when the table names it', () => {
    const named = { entitlements: [GRANTED], copyEntitlements: { 'some-private-surface': [GRANTED] } };
    expect(canCopyWithinSurface(named, 'some-private-surface')).toBe(false);
  });

  it('matches keys case- and whitespace-insensitively', () => {
    expect(canCopyWithinSurface({ entitlements: [` ${GRANTED.toUpperCase()} `], copyEntitlements }, GATED)).toBe(true);
  });

  it('always admits the main list', () => {
    expect(canCopyWithinSurface({ entitlements: [] }, null)).toBe(true);
  });
});

describe('a copy grant does not widen workspace use', () => {
  it('leaves canUseSurface false, so it admits no create', () => {
    expect(canUseSurface(grantHolder, GATED)).toBe(false);
  });

  it('still 403s a move or explicit copy target into the workspace', () => {
    expect(checkSurfaceTransition(grantHolder, null, GATED)).toMatchObject({ ok: false, status: 403 });
    expect(checkSurfaceTransition(grantHolder, GATED, GATED)).toMatchObject({ ok: false, status: 403 });
  });
});
