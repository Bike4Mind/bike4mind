import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import type { ResolveScopeDeps } from './resolveScope';
import { NO_TRUST, emailDomainOf, isTrustedUser, parseSpendTrustConfig, resolveTrustedScopes } from './trust';

const trust = parseSpendTrustConfig('example.com, @Corp.Example.org', 'org-trusted user-by-id');

const verified = (email: string | null, id = 'u1') => ({ id, email, emailVerified: true });

describe('parseSpendTrustConfig', () => {
  it('lower-cases domains, tolerates a leading @ and splits on commas or whitespace', () => {
    expect(trust.emailDomains).toEqual(new Set(['example.com', 'corp.example.org']));
    expect(trust.accountIds).toEqual(new Set(['org-trusted', 'user-by-id']));
    expect(parseSpendTrustConfig('', ' ')).toEqual(NO_TRUST);
  });
});

describe('emailDomainOf', () => {
  it('takes the part after the last @', () => {
    expect(emailDomainOf('a@b@Example.COM')).toBe('example.com');
    expect(emailDomainOf('no-at-sign')).toBeNull();
    expect(emailDomainOf('trailing@')).toBeNull();
    expect(emailDomainOf(null)).toBeNull();
  });
});

describe('isTrustedUser', () => {
  it('trusts a verified email on an exactly listed domain, in any case', () => {
    expect(isTrustedUser(verified('dev@example.com'), trust)).toBe(true);
    expect(isTrustedUser(verified('Dev@EXAMPLE.com'), trust)).toBe(true);
    expect(isTrustedUser(verified('dev@corp.example.org'), trust)).toBe(true);
  });

  it.each([
    'dev@evil-example.com',
    'dev@example.com.attacker.test',
    'dev@sub.example.com',
    'dev@example.co',
    'example.com@attacker.test',
  ])('does not trust the spoof %s', email => {
    expect(isTrustedUser(verified(email), trust)).toBe(false);
  });

  it('does not trust an unverified email on a trusted domain', () => {
    expect(isTrustedUser({ id: 'u1', email: 'dev@example.com', emailVerified: false }, trust)).toBe(false);
    expect(isTrustedUser({ id: 'u1', email: 'dev@example.com' }, trust)).toBe(false);
  });

  it('trusts a user listed by id whatever the email', () => {
    expect(isTrustedUser({ id: 'user-by-id', email: null }, trust)).toBe(true);
  });

  it('never matches a wildcard entry', () => {
    expect(isTrustedUser(verified('dev@sub.example.net'), parseSpendTrustConfig('*.example.net', ''))).toBe(false);
  });
});

function createDeps(overrides: Partial<ResolveScopeDeps> = {}) {
  const deps = {
    findUsersByIds: vi.fn<ResolveScopeDeps['findUsersByIds']>(async ids =>
      ids.map(id => ({
        id,
        email: id.startsWith('staff') ? `${id}@example.com` : `${id}@other.example.net`,
        emailVerified: id !== 'staff-unverified',
      }))
    ),
    findOrganizationsByIds: vi.fn<ResolveScopeDeps['findOrganizationsByIds']>(async () => []),
    findApiKeysByIds: vi.fn<ResolveScopeDeps['findApiKeysByIds']>(async () => [
      { id: 'key-staff', name: 'k', userId: 'staff-1' },
      { id: 'key-outsider', name: 'k', userId: 'outsider' },
      {
        id: 'key-org-billed',
        name: 'k',
        userId: 'staff-1',
        billingOwnerType: CreditHolderType.Organization,
        organizationId: 'org-plain',
      },
    ]),
    findAgentsByIds: vi.fn<ResolveScopeDeps['findAgentsByIds']>(async () => [
      { id: 'agent-staff', name: 'a', userId: 'staff-1' },
      { id: 'agent-org', name: 'a', organizationId: 'org-trusted' },
    ]),
    ...overrides,
  };
  return deps;
}

describe('resolveTrustedScopes', () => {
  it('resolves every scope type with one batched lookup per entity type', async () => {
    const deps = createDeps();
    const trusted = await resolveTrustedScopes(
      [
        { scopeType: 'User', scopeId: 'staff-1' },
        { scopeType: 'User', scopeId: 'staff-unverified' },
        { scopeType: 'User', scopeId: 'outsider' },
        { scopeType: 'User', scopeId: 'user-by-id' },
        { scopeType: 'Organization', scopeId: 'org-trusted' },
        { scopeType: 'Organization', scopeId: 'org-plain' },
        { scopeType: 'apiKey', scopeId: 'key-staff' },
        { scopeType: 'apiKey', scopeId: 'key-outsider' },
        { scopeType: 'apiKey', scopeId: 'key-org-billed' },
        { scopeType: 'Agent', scopeId: 'agent-staff' },
        { scopeType: 'Agent', scopeId: 'agent-org' },
      ],
      trust,
      deps
    );

    expect([...trusted].sort()).toEqual(
      [
        'User:staff-1',
        'User:user-by-id',
        'Organization:org-trusted',
        'apiKey:key-staff',
        'Agent:agent-staff',
        'Agent:agent-org',
      ].sort()
    );
    expect(deps.findUsersByIds).toHaveBeenCalledTimes(1);
    expect(deps.findApiKeysByIds).toHaveBeenCalledTimes(1);
    expect(deps.findAgentsByIds).toHaveBeenCalledTimes(1);
    // Organizations are trusted by id only, never by their members' domains.
    expect(deps.findOrganizationsByIds).not.toHaveBeenCalled();
  });

  it('runs no query when no trust is configured', async () => {
    const deps = createDeps();
    const trusted = await resolveTrustedScopes([{ scopeType: 'User', scopeId: 'staff-1' }], NO_TRUST, deps);
    expect(trusted.size).toBe(0);
    expect(Object.values(deps).every(fn => fn.mock.calls.length === 0)).toBe(true);
  });

  it('skips the user lookup when only account ids are listed', async () => {
    const deps = createDeps();
    const trusted = await resolveTrustedScopes(
      [{ scopeType: 'User', scopeId: 'user-by-id' }],
      parseSpendTrustConfig('', 'user-by-id'),
      deps
    );
    expect([...trusted]).toEqual(['User:user-by-id']);
    expect(deps.findUsersByIds).not.toHaveBeenCalled();
  });
});
