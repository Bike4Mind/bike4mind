import { describe, expect, it, vi } from 'vitest';
import type { NavigationIntent } from '@bike4mind/common';

vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [{ path: '/opti' }] }));

import { intentSurface, leadsIntoHiddenSurface } from './navigationIntentSurface';

const intent = (navigationType: string, target: string) => ({ navigationType, target }) as NavigationIntent;
const outside = { hiddenSurfaces: ['opti'], pathname: '/notebooks/abc', hostHandlesFamilyInPlace: false };

describe('intentSurface', () => {
  it('maps workspace routes and family actions to the workspace, everything else to the main app', () => {
    expect(intentSurface(intent('route', '/opti?mode=canvas'))).toBe('opti');
    expect(intentSurface(intent('action', 'scheduling.solvers'))).toBe('opti');
    expect(intentSurface(intent('action', 'file_browser'))).toBeNull();
    expect(intentSurface(intent('route', '/optimize-later'))).toBeNull();
    expect(intentSurface(intent('tab', '3'))).toBeNull();
  });
});

describe('leadsIntoHiddenSurface', () => {
  it('flags a suggestion into a hidden workspace from outside it', () => {
    expect(leadsIntoHiddenSurface(intent('route', '/opti'), outside)).toBe(true);
    expect(leadsIntoHiddenSurface(intent('action', 'scheduling'), outside)).toBe(true);
  });

  it('does not flag it once the user is already in the workspace', () => {
    expect(leadsIntoHiddenSurface(intent('action', 'scheduling'), { ...outside, pathname: '/opti' })).toBe(false);
    expect(leadsIntoHiddenSurface(intent('action', 'scheduling'), { ...outside, hostHandlesFamilyInPlace: true })).toBe(
      false
    );
  });

  it('does not flag anything when the workspace is not hidden', () => {
    expect(leadsIntoHiddenSurface(intent('route', '/opti'), { ...outside, hiddenSurfaces: [] })).toBe(false);
  });
});
