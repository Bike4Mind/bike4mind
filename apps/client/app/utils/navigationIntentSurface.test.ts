import { describe, expect, it } from 'vitest';
import type { NavigationIntent } from '@bike4mind/common';

import { intentSurface, leadsIntoHiddenSurface } from './navigationIntentSurface';

const intent = (navigationType: string, target: string) => ({ navigationType, target }) as NavigationIntent;
const outside = { hiddenSurfaces: ['opti'], pathname: '/notebooks/abc', hostHandlesFamilyInPlace: false };

describe('intentSurface', () => {
  it('maps workspace routes and known family actions to the workspace', () => {
    expect(intentSurface(intent('route', '/opti?mode=canvas'))).toBe('opti');
    expect(intentSurface(intent('route', '/opti/session/1'))).toBe('opti');
    expect(intentSurface(intent('action', 'scheduling'))).toBe('opti');
    expect(intentSurface(intent('action', 'scheduling.solvers'))).toBe('opti');
  });

  it('maps everything else, including unknown actions, to the main app', () => {
    expect(intentSurface(intent('action', 'file_browser'))).toBeNull();
    expect(intentSurface(intent('action', 'some_future_action'))).toBeNull();
    expect(intentSurface(intent('route', '/optimize-later'))).toBeNull();
    expect(intentSurface(intent('tab', '3'))).toBeNull();
  });
});

describe('leadsIntoHiddenSurface', () => {
  it('flags a suggestion into a hidden workspace from outside it', () => {
    expect(leadsIntoHiddenSurface(intent('route', '/opti'), outside)).toBe(true);
    expect(leadsIntoHiddenSurface(intent('action', 'scheduling'), outside)).toBe(true);
  });

  it('never flags an unknown action', () => {
    expect(leadsIntoHiddenSurface(intent('action', 'some_future_action'), outside)).toBe(false);
  });

  it('does not flag it anywhere under the workspace route prefix', () => {
    expect(leadsIntoHiddenSurface(intent('action', 'scheduling'), { ...outside, pathname: '/opti' })).toBe(false);
    expect(leadsIntoHiddenSurface(intent('route', '/opti'), { ...outside, pathname: '/opti/session/1' })).toBe(false);
  });

  it('does not treat a route that only shares the prefix text as inside the workspace', () => {
    expect(leadsIntoHiddenSurface(intent('route', '/opti'), { ...outside, pathname: '/optimize-later' })).toBe(true);
  });

  it('does not flag a family action while a host draws the console in place', () => {
    expect(leadsIntoHiddenSurface(intent('action', 'scheduling'), { ...outside, hostHandlesFamilyInPlace: true })).toBe(
      false
    );
  });

  it('does not flag anything when the workspace is not hidden', () => {
    expect(leadsIntoHiddenSurface(intent('route', '/opti'), { ...outside, hiddenSurfaces: [] })).toBe(false);
  });
});
