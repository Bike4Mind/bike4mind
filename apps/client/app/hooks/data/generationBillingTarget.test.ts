import { describe, expect, it } from 'vitest';
import { payerLabel } from './generationBillingTarget';

describe('payerLabel', () => {
  it('names personal credits', () => {
    expect(payerLabel({ name: 'Me', personal: true })).toBe('your personal credits');
  });

  it('names the organization', () => {
    expect(payerLabel({ name: 'Acme', personal: false })).toBe('Acme credits');
  });

  it('is null with no selection', () => {
    expect(payerLabel(null)).toBeNull();
  });
});
