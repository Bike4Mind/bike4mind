import { describe, expect, it } from 'vitest';
import { emailDomainsOf, planEmailDomains } from './emailDomains';

const users = (...emails: (string | null)[]) => emails.map(email => ({ email }));

describe('emailDomainsOf', () => {
  it('splits owned domains from public mailbox providers and public suffixes', () => {
    expect(emailDomainsOf(users('a@acme.com', 'b@gmail.com', 'c@someone.co.uk', 'd@co.uk'))).toEqual({
      owned: ['acme.com', 'someone.co.uk'],
      notOwned: ['co.uk', 'gmail.com'],
    });
  });

  it('skips users without an email', () => {
    expect(emailDomainsOf(users(null, 'not-an-email', 'a@acme.com'))).toEqual({ owned: ['acme.com'], notOwned: [] });
  });

  it('dedupes and sorts', () => {
    expect(emailDomainsOf(users('a@Zeta.com', 'b@alpha.com', 'c@zeta.com', 'd@alpha.com')).owned).toEqual([
      'alpha.com',
      'zeta.com',
    ]);
  });

  it('keeps a subdomain exact instead of widening to its parent', () => {
    expect(emailDomainsOf(users('a@mail.acme.com')).owned).toEqual(['mail.acme.com']);
  });

  it('drops a subdomain whose parent is also in the cohort', () => {
    expect(emailDomainsOf(users('a@mail.acme.com', 'b@acme.com', 'c@eu.mail.other.com')).owned).toEqual([
      'acme.com',
      'eu.mail.other.com',
    ]);
  });
});

describe('planEmailDomains', () => {
  it('reports a domain covered by a listed parent as already blocked', () => {
    const plan = planEmailDomains(
      users('a@mail.acme.com', 'b@fresh.io', 'c@gmail.com', 'd@listed.org'),
      new Set(['acme.com', 'listed.org'])
    );
    expect(plan).toEqual({
      toBlock: ['fresh.io'],
      alreadyBlocked: ['listed.org', 'mail.acme.com'],
      notOwned: ['gmail.com'],
    });
  });
});
