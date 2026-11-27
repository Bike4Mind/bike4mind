import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
import en from './en.json';

describe('en.json organization plurals', () => {
  it('resolves x_seats through i18next plural suffixes', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    expect(i18n.t('organization.x_seats', { count: 1 })).toBe('1 seat');
    expect(i18n.t('organization.x_seats', { count: 2 })).toBe('2 seats');
  });

  it('resolves x_members and x_credits through i18next plural suffixes', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    expect(i18n.t('organization.x_members', { count: 1 })).toBe('1 member');
    expect(i18n.t('organization.x_members', { count: 2 })).toBe('2 members');
    expect(i18n.t('organization.x_credits', { count: 1, amount: '1' })).toBe('1 credit');
    expect(i18n.t('organization.x_credits', { count: 1200, amount: '1,200' })).toBe('1,200 credits');
  });

  it('resolves the referral milestone lines through i18next plural suffixes', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    expect(i18n.t('referral.milestone_next', { count: 1, credits: '500' })).toBe(
      '<strong>1 more active friend</strong> to earn a <strong>500 credit</strong> bonus.'
    );
    expect(i18n.t('referral.milestone_next', { count: 3, credits: '1,500' })).toBe(
      '<strong>3 more active friends</strong> to earn a <strong>1,500 credit</strong> bonus.'
    );
    expect(i18n.t('referral.milestone_chip', { count: 1, credits: '200' })).toBe('1 friend: 200');
    expect(i18n.t('referral.milestone_chip', { count: 5, credits: '500' })).toBe('5 friends: 500');
  });
});
