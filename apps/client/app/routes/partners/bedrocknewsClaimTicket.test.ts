// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { takeTicket } from './bedrocknewsClaimTicket';

describe('takeTicket', () => {
  beforeEach(() => sessionStorage.clear());

  it('moves a hash ticket into session storage and clears the address', () => {
    window.history.replaceState(null, '', '/partners/bedrocknews/claim#ticket=abc');
    expect(takeTicket(undefined)).toBe('abc');
    expect(window.location.hash).toBe('');
    expect(takeTicket(undefined)).toBe('abc');
  });

  it('drops a query ticket from the address but keeps other params', () => {
    window.history.replaceState(null, '', '/partners/bedrocknews/claim?ticket=abc&x=1');
    expect(takeTicket('abc')).toBe('abc');
    expect(window.location.search).toBe('?x=1');
  });
});
