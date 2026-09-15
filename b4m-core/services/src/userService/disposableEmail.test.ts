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

  it('matches the domain after the last @ when the local part contains one', () => {
    expect(isDisposableEmail('a@b@mailinator.com')).toBe(true);
  });

  it('trims surrounding whitespace on the domain before matching', () => {
    expect(isDisposableEmail('x@  mailinator.com  ')).toBe(true);
  });

  it('returns false for an empty domain', () => {
    expect(isDisposableEmail('user@')).toBe(false);
  });

  it('is case-insensitive on the domain', () => {
    expect(isDisposableEmail('x@MAILINATOR.COM')).toBe(true);
  });
});
