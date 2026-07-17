import { describe, it, expect } from 'vitest';
import { isDisposableEmail } from './disposableEmail';

describe('isDisposableEmail', () => {
  it('flags a known disposable provider', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
  });

  it('flags subdomains of a disposable provider (parent-domain match)', () => {
    expect(isDisposableEmail('x@anything.mailinator.com')).toBe(true);
  });

  it('strips a trailing FQDN dot before matching', () => {
    expect(isDisposableEmail('x@mailinator.com.')).toBe(true);
  });

  it('allows a normal provider', () => {
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
  });

  it('returns false when there is no @', () => {
    expect(isDisposableEmail('notanemail')).toBe(false);
  });

  it('lazily loads the list on repeated calls without error', () => {
    // Second call reuses the cached Set (the lazy loader's memoized branch).
    expect(isDisposableEmail('a@gmail.com')).toBe(false);
    expect(isDisposableEmail('b@mailinator.com')).toBe(true);
  });
});
