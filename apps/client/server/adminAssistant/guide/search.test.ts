import { describe, expect, it } from 'vitest';
import { ADMIN_GUIDE } from '.';
import { searchAdminGuide } from './search';
import type { AdminGuideEntry } from './types';

const entry = (overrides: Partial<AdminGuideEntry> & Pick<AdminGuideEntry, 'id'>): AdminGuideEntry => ({
  title: '',
  summary: '',
  views: [],
  settings: [],
  howTo: [],
  keywords: [],
  ...overrides,
});

const FIXTURE = [
  entry({ id: 'holds', title: 'Signup domain holds', howTo: ['Release a domain to pay its held credits'] }),
  entry({ id: 'credits', title: 'Credit analytics', summary: 'Credits per user and the ledger' }),
  entry({ id: 'steps', title: 'Something else', howTo: ['Mentions a signup in passing'] }),
];

const idsFor = (query: string, guide: readonly AdminGuideEntry[] = FIXTURE, limit = 3) =>
  searchAdminGuide(guide, query, limit).map(match => match.entry.id);

describe('searchAdminGuide', () => {
  it('drops an entry the query only mentions in passing', () => {
    // 'steps' says "signup" only in its body, never in its title or keywords.
    expect(idsFor('signup')).toEqual(['holds']);
  });

  it('matches plural and singular forms alike', () => {
    expect(idsFor('domain hold')[0]).toBe('holds');
    expect(idsFor('credit')[0]).toBe('credits');
  });

  it('returns nothing when no entry covers the question', () => {
    expect(idsFor('lighthouse rewards')).toEqual([]);
    expect(idsFor('how do I')).toEqual([]);
  });

  it('needs most of the question, not one shared word', () => {
    expect(idsFor('credit chargeback')).toEqual([]);
    expect(idsFor('signup holds')).toEqual(['holds']);
  });

  it('needs more than half the terms, so one of two is not enough', () => {
    expect(idsFor('signup chargeback')).toEqual([]);
  });

  it('accepts two of three terms when one names the feature', () => {
    expect(idsFor('signup holds chargeback')).toEqual(['holds']);
  });

  it('caps the matches at the limit', () => {
    expect(idsFor('signup', FIXTURE, 1)).toHaveLength(1);
  });
});

describe('searchAdminGuide over ADMIN_GUIDE', () => {
  const topFor = (query: string) => searchAdminGuide(ADMIN_GUIDE, query, 3)[0]?.entry;

  it('answers where AI advisories are', () => {
    expect(topFor('Where can I see the AI advisories?')?.views).toEqual(
      expect.arrayContaining(['admin.dashboard', 'admin.users', 'admin.shadow_detections'])
    );
  });

  it('answers what Signup domain holds is for', () => {
    expect(topFor('What is the Signup domain holds tab for?')?.views[0]).toBe('admin.signup_domain_holds');
  });

  it('has nothing for a feature that does not exist', () => {
    expect(searchAdminGuide(ADMIN_GUIDE, 'What does the Lighthouse Rewards tab do?', 3)).toEqual([]);
    // Real words, made-up feature: "user" is everywhere, but no entry is named "rewards".
    expect(searchAdminGuide(ADMIN_GUIDE, 'What does the user rewards tab do?', 3)).toEqual([]);
  });

  it('meets verb forms with the entry that names the task', () => {
    expect(topFor('delegating admin rights')?.id).toBe('delegated-admin-permissions');
    expect(topFor('delegate admin access to a user')?.id).toBe('delegated-admin-permissions');
    expect(topFor('unban a banned user')?.id).toBe('user-suspend-restrict');
    expect(topFor('refunding credits')?.id).toBe('user-adjust-credits');
  });

  it('reads past request verbs to the feature name', () => {
    expect(topFor('Explain AI advisories')?.id).toBe('ai-advisory');
    expect(topFor('tell me about Gears')?.id).toBe('gears');
  });
});
