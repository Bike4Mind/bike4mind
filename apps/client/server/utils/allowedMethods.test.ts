import { describe, expect, it } from 'vitest';
import { resolveAllowedMethods } from './allowedMethods';

describe('resolveAllowedMethods', () => {
  it('upper-cases and adds HEAD right after GET', () => {
    expect(resolveAllowedMethods(['get', 'post'])).toEqual(['GET', 'HEAD', 'POST']);
  });

  it('does not duplicate an explicit HEAD', () => {
    expect(resolveAllowedMethods(['GET', 'HEAD'])).toEqual(['GET', 'HEAD']);
  });

  it('adds nothing when GET is not served', () => {
    expect(resolveAllowedMethods(['post', 'delete'])).toEqual(['POST', 'DELETE']);
  });
});
