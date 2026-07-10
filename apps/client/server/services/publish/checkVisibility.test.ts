import { describe, it, expect } from 'vitest';
import { checkVisibility, type VisibilityCheckArtifact } from './checkVisibility';
import type { PublishUser } from './checkScopePermission';

const artifact = (over: Partial<VisibilityCheckArtifact> = {}): VisibilityCheckArtifact => ({
  visibility: 'private',
  ownerId: 'owner1',
  scopeId: 'scope1',
  accessGate: null,
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

// ── Access gates (issue #383) — layered on top of visibility: 'public' ────────
import { vi, beforeEach } from 'vitest';

const { mockUserFindById } = vi.hoisted(() => ({ mockUserFindById: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: (...a: unknown[]) => ({
      select: () => ({ lean: () => Promise.resolve(mockUserFindById(...a)) }),
    }),
  },
}));

const gatedBase = { ownerId: 'owner1', scopeId: 'scope1' } as const;
const gViewer = { id: 'viewer1' };
const gOwner = { id: 'owner1' };
const gAdmin = { id: 'someone', isAdmin: true };

beforeEach(() => {
  mockUserFindById.mockReset().mockResolvedValue(null);
});

describe('checkVisibility — passphrase gate', () => {
  const gated = { ...gatedBase, visibility: 'public' as const, accessGate: { kind: 'passphrase' as const } };

  it('denies without proof, flagging reason so the serve route can prompt', async () => {
    expect(await checkVisibility(gated, undefined)).toEqual({
      ok: false,
      status: 401,
      error: 'Passphrase required',
      reason: 'passphrase',
    });
  });
  it('admits with a verified proof (anonymous is fine — the proof IS the credential)', async () => {
    expect(await checkVisibility(gated, undefined, { passphraseVerified: true })).toEqual({ ok: true });
  });
  it('a logged-in non-owner without proof is still denied — login is not the credential', async () => {
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, reason: 'passphrase' });
  });
  it('owner and admin bypass their own gate', async () => {
    expect(await checkVisibility(gated, gOwner)).toEqual({ ok: true });
    expect(await checkVisibility(gated, gAdmin)).toEqual({ ok: true });
  });
});

describe('checkVisibility — domain gate', () => {
  const gated = {
    ...gatedBase,
    visibility: 'public' as const,
    accessGate: { kind: 'domain' as const, allowedDomains: ['acme.com', 'partner.co'] },
  };

  it('requires login first (401 + reason so the loader shell can offer sign-in)', async () => {
    expect(await checkVisibility(gated, undefined)).toMatchObject({ ok: false, status: 401, reason: 'domain' });
  });
  it('admits a VERIFIED email on an allowlisted domain, case-insensitively', async () => {
    mockUserFindById.mockResolvedValue({ email: 'Jo@ACME.com', emailVerified: true });
    expect(await checkVisibility(gated, gViewer)).toEqual({ ok: true });
  });
  it('rejects an unverified email even on the right domain', async () => {
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.com', emailVerified: false });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, status: 403, reason: 'domain' });
  });
  it('rejects a verified email on the wrong domain — exact match only, no suffix tricks', async () => {
    mockUserFindById.mockResolvedValue({ email: 'jo@evilacme.com', emailVerified: true });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, status: 403 });
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.com.evil.io', emailVerified: true });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, status: 403 });
  });
  it('fails closed on a misconfigured empty allowlist', async () => {
    const empty = {
      ...gatedBase,
      visibility: 'public' as const,
      accessGate: { kind: 'domain' as const, allowedDomains: [] },
    };
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.com', emailVerified: true });
    expect(await checkVisibility(empty, gViewer)).toMatchObject({ ok: false, status: 403 });
  });
  it('owner and admin bypass the domain gate', async () => {
    expect(await checkVisibility(gated, gOwner)).toEqual({ ok: true });
    expect(await checkVisibility(gated, gAdmin)).toEqual({ ok: true });
  });
});
