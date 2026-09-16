import { describe, it, expect } from 'vitest';
import { unsavedFieldKeys, unsavedFieldLabels } from './unsavedFieldLabels';

describe('unsavedFieldKeys', () => {
  it('returns only the fields actually marked as edited', () => {
    expect(unsavedFieldKeys({})).toEqual([]);
    expect(unsavedFieldKeys({ tags: false })).toEqual([]);
    expect(unsavedFieldKeys({ tags: true, name: false })).toEqual(['tags']);
  });
});

describe('unsavedFieldLabels', () => {
  it('names the tags field, the one the Custom Tags Add button stages', () => {
    expect(unsavedFieldLabels(['tags'])).toEqual(['Tags and product access']);
  });

  it('collapses fields that always move together into one label', () => {
    expect(unsavedFieldLabels(['emailVerified', 'emailVerifiedAt'])).toEqual(['Email verification']);
  });

  it('lists multiple fields in a stable order regardless of edit order', () => {
    expect(unsavedFieldLabels(['currentCredits', 'name'])).toEqual(['Name', 'Credits']);
    expect(unsavedFieldLabels(['name', 'currentCredits'])).toEqual(['Name', 'Credits']);
  });

  it('falls back to a prettified key for a field with no label mapping', () => {
    expect(unsavedFieldLabels(['stripeCustomerId'])).toEqual(['Stripe Customer Id']);
  });

  it('returns nothing for no keys', () => {
    expect(unsavedFieldLabels([])).toEqual([]);
  });
});
