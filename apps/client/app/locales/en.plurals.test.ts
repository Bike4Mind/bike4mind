import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
import en from './en.json';

describe('en.json seat plurals', () => {
  it('resolves x_seats through i18next plural suffixes', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    expect(i18n.t('organization.x_seats', { count: 1 })).toBe('1 seat');
    expect(i18n.t('organization.x_seats', { count: 2 })).toBe('2 seats');
  });
});
