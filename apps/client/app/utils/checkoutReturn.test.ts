import { describe, expect, it } from 'vitest';
import { allowedCheckoutReturn, checkoutCallbackUrl } from './checkoutReturn';

describe('checkout started from another Bike4Mind app', () => {
  it('returns only to an allowed https origin', () => {
    expect(allowedCheckoutReturn('https://paintbox.bike4mind.com/')).toBe('https://paintbox.bike4mind.com/');
    expect(allowedCheckoutReturn('https://paintbox.bike4mind.com/?upgraded=1')).toBe(
      'https://paintbox.bike4mind.com/?upgraded=1'
    );
    for (const value of [
      'http://paintbox.bike4mind.com/',
      'https://paintbox.bike4mind.com.evil.example/',
      'https://evil.example/?https://paintbox.bike4mind.com',
      'https://user:pass@paintbox.bike4mind.com/',
      '//paintbox.bike4mind.com/',
      '/new',
      'javascript:alert(1)',
      '',
      undefined,
      ['https://paintbox.bike4mind.com/'],
    ]) {
      expect(allowedCheckoutReturn(value)).toBeNull();
    }
  });

  it('keeps Stripe on this origin, carrying the target as a parameter', () => {
    expect(checkoutCallbackUrl('https://app.bike4mind.com', null)).toBe('https://app.bike4mind.com');
    const url = new URL(checkoutCallbackUrl('https://app.bike4mind.com', 'https://paintbox.bike4mind.com/'));
    expect(url.origin).toBe('https://app.bike4mind.com');
    expect(url.searchParams.get('checkout_return_to')).toBe('https://paintbox.bike4mind.com/');
  });
});
