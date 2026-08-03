import { describe, it, expect } from 'vitest';
import { resolveArtifactsEnabled } from './artifactGating';

describe('resolveArtifactsEnabled', () => {
  it('requires the admin setting: no request flag can turn artifacts back on', () => {
    expect(resolveArtifactsEnabled(false, true)).toBe(false);
    expect(resolveArtifactsEnabled(false, false)).toBe(false);
    expect(resolveArtifactsEnabled(false, undefined)).toBe(false);
  });

  it('honours an explicit opt-out from the caller', () => {
    expect(resolveArtifactsEnabled(true, false)).toBe(false);
  });

  it('leaves the admin setting as the only gate when the caller says nothing', () => {
    // Regression lock: most internal callers never set the flag. Reading absence as "off" would
    // silently strip artifacts from every one of them.
    expect(resolveArtifactsEnabled(true, undefined)).toBe(true);
  });

  it('is on when both agree', () => {
    expect(resolveArtifactsEnabled(true, true)).toBe(true);
  });
});
