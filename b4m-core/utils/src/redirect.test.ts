import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect';

describe('safeRedirectPath', () => {
  it('keeps a same-origin path', () => {
    expect(safeRedirectPath('/notebooks/123')).toBe('/notebooks/123');
  });

  it('falls back on an absolute URL', () => {
    expect(safeRedirectPath('https://example.com/x')).toBe('/');
  });

  it('falls back on an empty target', () => {
    expect(safeRedirectPath(undefined, '/home')).toBe('/home');
  });
});
