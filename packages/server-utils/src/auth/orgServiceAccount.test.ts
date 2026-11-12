import { describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';
vi.mock('@bike4mind/database', () => ({ organizationRepository: {}, Project: {} }));
import { serviceAccountRequestGrant } from './orgServiceAccount';

const account = {
  organizationId: 'org',
  createdByUserId: 'deleted-creator',
  grants: [
    { resourceType: 'organization' as const, resourceId: 'org', permission: 'compute' as const },
    { resourceType: 'project' as const, resourceId: 'project', permission: 'read' as const },
  ],
};
const key = {
  serviceAccount: true,
  organizationId: 'org',
  billingOwnerType: CreditHolderType.Organization,
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.READ_PROJECTS],
};

describe('service account scope and resource intersection', () => {
  it('uses its own grants without depending on the creator', () => {
    expect(serviceAccountRequestGrant(account, key, { method: 'POST', path: '/api/lattice/chat' })?.permission).toBe(
      'compute'
    );
    expect(
      serviceAccountRequestGrant(account, key, { method: 'GET', path: '/api/v1/projects/[id]', resourceId: 'project' })
        ?.permission
    ).toBe('read');
  });
  it('requires both the grant and scope', () => {
    expect(
      serviceAccountRequestGrant(account, { ...key, scopes: [] }, { method: 'POST', path: '/api/lattice/chat' })
    ).toBeNull();
    expect(
      serviceAccountRequestGrant({ ...account, grants: [] }, key, { method: 'POST', path: '/api/lattice/chat' })
    ).toBeNull();
  });
  it('denies cross-org billing and ungranted resources', () => {
    expect(
      serviceAccountRequestGrant(
        account,
        { ...key, organizationId: 'other' },
        { method: 'POST', path: '/api/lattice/chat' }
      )
    ).toBeNull();
    expect(
      serviceAccountRequestGrant(account, key, { method: 'GET', path: '/api/v1/projects/[id]', resourceId: 'other' })
    ).toBeNull();
  });
  it.each(['/api/chat', '/api/user-api-keys', '/api/organizations/org', '/api/v1/projects/project/files'])(
    'denies unsupported route %s',
    path => {
      expect(serviceAccountRequestGrant(account, key, { method: 'POST', path })).toBeNull();
    }
  );
  it('denies writes even to a readable resource', () => {
    expect(
      serviceAccountRequestGrant(account, key, {
        method: 'PATCH',
        path: '/api/v1/projects/[id]',
        resourceId: 'project',
      })
    ).toBeNull();
  });
});
