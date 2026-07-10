import { describe, it, expect } from 'vitest';
import { checkVisibility, type VisibilityCheckArtifact } from './checkVisibility';
import type { PublishUser } from './checkScopePermission';

const artifact = (over: Partial<VisibilityCheckArtifact> = {}): VisibilityCheckArtifact => ({
  visibility: 'private',
  ownerId: 'owner1',
  scopeId: 'scope1',
  ...over,
});

const user = (over: Partial<PublishUser> = {}): PublishUser => ({
  id: 'viewer1',
  isAdmin: false,
  organizationId: null,
  ...over,
});

describe('checkVisibility', () => {
  it('allows anyone (even anonymous) to view a public artifact', async () => {
    expect(await checkVisibility(artifact({ visibility: 'public' }), undefined)).toEqual({ ok: true });
  });

  it('401s an anonymous viewer of a non-public artifact', async () => {
    const r = await checkVisibility(artifact({ visibility: 'organization' }), undefined);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('always allows the owner and an admin regardless of visibility', async () => {
    expect(await checkVisibility(artifact({ visibility: 'private' }), user({ id: 'owner1' }))).toEqual({ ok: true });
    expect(await checkVisibility(artifact({ visibility: 'organization' }), user({ isAdmin: true }))).toEqual({
      ok: true,
    });
  });

  describe('organization visibility (org-tier stores org id as scopeId)', () => {
    it('allows a same-org member (viewer org matches scopeId)', async () => {
      const r = await checkVisibility(
        artifact({ visibility: 'organization', scopeId: 'org_42', ownerId: 'someone-else' }),
        user({ organizationId: 'org_42' })
      );
      expect(r).toEqual({ ok: true });
    });

    it('403s a viewer whose org does not match the scopeId', async () => {
      const r = await checkVisibility(
        artifact({ visibility: 'organization', scopeId: 'org_42', ownerId: 'someone-else' }),
        user({ organizationId: 'org_99' })
      );
      expect(r).toMatchObject({ ok: false, status: 403 });
    });

    it('403s a viewer with no org', async () => {
      const r = await checkVisibility(
        artifact({ visibility: 'organization', scopeId: 'org_42', ownerId: 'someone-else' }),
        user({ organizationId: null })
      );
      expect(r).toMatchObject({ ok: false, status: 403 });
    });

    it('does not authorize by a user-tier record whose scopeId is the owner id (the pre-fix 403 case)', async () => {
      // A user-tier record marked org visibility has scopeId = owner user id, never a viewer's
      // org id - so an org member must still 403. #174 fixes this by publishing org tier, not by
      // loosening the gate.
      const r = await checkVisibility(
        artifact({ visibility: 'organization', scopeId: 'owner1', ownerId: 'owner1' }),
        user({ id: 'viewer1', organizationId: 'org_42' })
      );
      expect(r).toMatchObject({ ok: false, status: 403 });
    });
  });

  it('403s private for a non-owner non-admin', async () => {
    const r = await checkVisibility(artifact({ visibility: 'private' }), user());
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});
