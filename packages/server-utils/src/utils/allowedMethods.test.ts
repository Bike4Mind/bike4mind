import { describe, expect, it } from 'vitest';
import { createMethodGuard, resolveAllowedMethods } from './allowedMethods';

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

  it('keeps HEAD next to GET when GET is not first', () => {
    expect(resolveAllowedMethods(['put', 'get', 'delete'])).toEqual(['PUT', 'GET', 'HEAD', 'DELETE']);
  });

  it('returns an empty list for no methods', () => {
    expect(resolveAllowedMethods([])).toEqual([]);
  });
});

describe('createMethodGuard', () => {
  const check = createMethodGuard(['get', 'put']);

  it('allows a listed method and the HEAD implied by GET, case-insensitively', () => {
    expect(check('GET')).toEqual({ allowed: true });
    expect(check('head')).toEqual({ allowed: true });
    expect(check('PUT')).toEqual({ allowed: true });
  });

  it('rejects anything else with the Allow value and message every transport sends', () => {
    expect(check('post')).toEqual({
      allowed: false,
      allowHeader: 'GET, HEAD, PUT',
      message: 'Method POST is not allowed. Allowed: GET, HEAD, PUT',
    });
  });

  it('rejects a missing method', () => {
    expect(check(undefined).allowed).toBe(false);
  });
});
