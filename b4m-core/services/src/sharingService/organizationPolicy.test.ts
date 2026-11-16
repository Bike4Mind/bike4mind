import { describe, expect, it, vi } from 'vitest';
import type { IOrganizationDocument } from '@bike4mind/common';
import { assertContentInvitePolicy, assertContentPublicLinkPolicy } from './organizationPolicy';

const org = {
  userId: 'owner',
  users: [{ userId: 'member', permissions: ['read'] }],
  sharingPolicy: { allowPublicLinks: false, allowExternalSharing: false, allowedDomains: ['partner.example'] },
} as IOrganizationDocument;
const organizations = { findById: vi.fn(async () => org) };

describe('content invite policy', () => {
  it('refuses anonymous links and external recipients', async () => {
    await expect(assertContentInvitePolicy({ organizationId: 'org' }, [], organizations, true)).rejects.toThrow(
      'public links'
    );
    await expect(
      assertContentInvitePolicy(
        { organizationId: 'org' },
        [{ id: 'outsider', email: 'x@elsewhere.example' }],
        organizations
      )
    ).rejects.toThrow('approved email domains');
  });
  it('permits members and domain exceptions', async () => {
    await expect(
      assertContentInvitePolicy(
        { organizationId: 'org' },
        [{ id: 'member' }, { id: '', email: 'x@partner.example', emailVerified: true }],
        organizations
      )
    ).resolves.toBeUndefined();
  });
  it('leaves legacy personal content unchanged', async () => {
    await expect(assertContentInvitePolicy({}, [{ id: 'outsider' }], organizations, true)).resolves.toBeUndefined();
  });
  it('refuses an unverified address at an approved domain', async () => {
    await expect(
      assertContentInvitePolicy(
        { organizationId: 'org' },
        [{ id: 'outsider', email: 'x@partner.example', emailVerified: false }],
        organizations
      )
    ).rejects.toThrow('approved email domains');
  });
  it('applies the public-link rule to content made global', async () => {
    await expect(assertContentPublicLinkPolicy({ organizationId: 'org' }, organizations)).rejects.toThrow(
      'public links'
    );
    await expect(assertContentPublicLinkPolicy({}, organizations)).resolves.toBeUndefined();
  });
  it('refuses a missing content organization', async () => {
    await expect(
      assertContentInvitePolicy({ organizationId: 'missing' }, [], { findById: async () => null })
    ).rejects.toThrow('unavailable');
  });
});
