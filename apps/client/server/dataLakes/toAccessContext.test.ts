import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntitlementRequest } from '@server/entitlements';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockGetRequestEntitlements, mockFindMembershipOrgIds } = vi.hoisted(() => ({
  mockGetRequestEntitlements: vi.fn(),
  mockFindMembershipOrgIds: vi.fn(),
}));
vi.mock('@server/entitlements', () => ({ getRequestEntitlements: mockGetRequestEntitlements }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findMembershipOrgIds: mockFindMembershipOrgIds },
}));

import { toAccessContext } from './toAccessContext';

const req = (user: Record<string, unknown>) => ({ user }) as unknown as EntitlementRequest;

describe('toAccessContext - organization membership (#1674)', () => {
  beforeEach(() => {
    mockGetRequestEntitlements.mockReset();
    mockGetRequestEntitlements.mockResolvedValue([]);
    mockFindMembershipOrgIds.mockReset();
    mockFindMembershipOrgIds.mockResolvedValue([]);
  });

  it('builds organizationIds from findMembershipOrgIds(user.id), NOT from user.organizationId', async () => {
    // user.organizationId is the "currently selected org" display preference, and must never
    // drive an authorization decision - the real source is the owner + users[] ACL lookup.
    mockFindMembershipOrgIds.mockResolvedValue(['org-a']);
    const ctx = await toAccessContext(req({ id: 'u1', tags: [], organizationId: 'org-b' }));

    expect(mockFindMembershipOrgIds).toHaveBeenCalledWith('u1');
    expect(ctx.organizationIds).toEqual(['org-a']);
  });

  it('yields an empty membership set for a member of no organization', async () => {
    mockFindMembershipOrgIds.mockResolvedValue([]);
    const ctx = await toAccessContext(req({ id: 'u1', tags: [] }));
    expect(ctx.organizationIds).toEqual([]);
  });

  it('reflects membership in multiple organizations', async () => {
    mockFindMembershipOrgIds.mockResolvedValue(['org-a', 'org-b']);
    const ctx = await toAccessContext(req({ id: 'u1', tags: [] }));
    expect(ctx.organizationIds).toEqual(['org-a', 'org-b']);
  });

  it('resolves membership for an admin too (org gates still apply to admins on some paths)', async () => {
    mockFindMembershipOrgIds.mockResolvedValue(['org-a']);
    const ctx = await toAccessContext(req({ id: 'admin', isAdmin: true, tags: [] }));

    expect(ctx.isAdmin).toBe(true);
    expect(ctx.entitlementKeys).toEqual([]);
    expect(ctx.organizationIds).toEqual(['org-a']);
    expect(mockGetRequestEntitlements).not.toHaveBeenCalled();
  });
});
