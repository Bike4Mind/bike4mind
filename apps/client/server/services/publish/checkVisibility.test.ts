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

// Access gates (issue #383) - layered on top of visibility: 'public'
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

describe('checkVisibility - passphrase gate', () => {
  const gated = { ...gatedBase, visibility: 'public' as const, accessGate: { kind: 'passphrase' as const } };

  it('denies without proof, flagging reason so the serve route can prompt', async () => {
    expect(await checkVisibility(gated, undefined)).toEqual({
      ok: false,
      status: 401,
      error: 'Passphrase required',
      reason: 'passphrase',
    });
  });
  it('admits with a verified proof (anonymous is fine - the proof IS the credential)', async () => {
    expect(await checkVisibility(gated, undefined, { passphraseVerified: true })).toEqual({ ok: true });
  });
  it('a logged-in non-owner without proof is still denied - login is not the credential', async () => {
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, reason: 'passphrase' });
  });
  it('owner and admin bypass their own gate', async () => {
    expect(await checkVisibility(gated, gOwner)).toEqual({ ok: true });
    expect(await checkVisibility(gated, gAdmin)).toEqual({ ok: true });
  });
});

describe('checkVisibility - domain gate', () => {
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
    // Success also reports the viewer's registrable domain so the caller can audit
    // the view without a second lookup.
    expect(await checkVisibility(gated, gViewer)).toEqual({ ok: true, viewerEmailDomain: 'acme.com' });
  });
  it('rejects an unverified email even on the right domain', async () => {
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.com', emailVerified: false });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, status: 403, reason: 'domain' });
  });
  it('rejects a verified email on a lookalike domain - no suffix tricks', async () => {
    // evilacme.com does not end in '.acme.com'; acme.com.evil.io ends in evil.io.
    mockUserFindById.mockResolvedValue({ email: 'jo@evilacme.com', emailVerified: true });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, status: 403 });
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.com.evil.io', emailVerified: true });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: false, status: 403 });
  });
  it('admits a verified viewer on a SUBDOMAIN of an allowlisted org domain', async () => {
    mockUserFindById.mockResolvedValue({ email: 'jo@mail.acme.com', emailVerified: true });
    expect(await checkVisibility(gated, gViewer)).toMatchObject({ ok: true, viewerEmailDomain: 'acme.com' });
  });
  it('does NOT widen a subdomain allowlist ENTRY to its parent org', async () => {
    // Allowlisting mail.acme.com must admit mail.acme.com (and its subdomains) only -
    // never hr.acme.com or the bare acme.com org.
    const subEntry = {
      ...gatedBase,
      visibility: 'public' as const,
      accessGate: { kind: 'domain' as const, allowedDomains: ['mail.acme.com'] },
    };
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.com', emailVerified: true });
    expect(await checkVisibility(subEntry, gViewer)).toMatchObject({ ok: false, status: 403 });
    mockUserFindById.mockResolvedValue({ email: 'jo@hr.acme.com', emailVerified: true });
    expect(await checkVisibility(subEntry, gViewer)).toMatchObject({ ok: false, status: 403 });
    mockUserFindById.mockResolvedValue({ email: 'jo@mail.acme.com', emailVerified: true });
    expect(await checkVisibility(subEntry, gViewer)).toMatchObject({ ok: true });
    mockUserFindById.mockResolvedValue({ email: 'jo@eu.mail.acme.com', emailVerified: true });
    expect(await checkVisibility(subEntry, gViewer)).toMatchObject({ ok: true });
  });
  it('does NOT admit a sibling tenant under a shared SaaS suffix (onmicrosoft.com)', async () => {
    // The core of the security fix: an entry must never be reduced to its registrable
    // domain, or acme.onmicrosoft.com would collapse to onmicrosoft.com and admit every
    // other Microsoft 365 tenant.
    const tenant = {
      ...gatedBase,
      visibility: 'public' as const,
      accessGate: { kind: 'domain' as const, allowedDomains: ['acme.onmicrosoft.com'] },
    };
    mockUserFindById.mockResolvedValue({ email: 'jo@evil.onmicrosoft.com', emailVerified: true });
    expect(await checkVisibility(tenant, gViewer)).toMatchObject({ ok: false, status: 403 });
    mockUserFindById.mockResolvedValue({ email: 'jo@acme.onmicrosoft.com', emailVerified: true });
    expect(await checkVisibility(tenant, gViewer)).toMatchObject({ ok: true });
  });
  it('admits a subdomain viewer across a multi-level public suffix (acme.co.uk)', async () => {
    const coUk = {
      ...gatedBase,
      visibility: 'public' as const,
      accessGate: { kind: 'domain' as const, allowedDomains: ['acme.co.uk'] },
    };
    mockUserFindById.mockResolvedValue({ email: 'jo@sub.acme.co.uk', emailVerified: true });
    expect(await checkVisibility(coUk, gViewer)).toMatchObject({ ok: true });
  });
  it('fails closed when the allowlist has only invalid (public/private-suffix) entries', async () => {
    // Bare public suffix co.uk and bare private suffix github.io are both dropped, so a
    // legacy/misconfigured entry can never admit an entire shared suffix.
    const bogus = {
      ...gatedBase,
      visibility: 'public' as const,
      accessGate: { kind: 'domain' as const, allowedDomains: ['co.uk', 'github.io'] },
    };
    mockUserFindById.mockResolvedValue({ email: 'jo@anything.co.uk', emailVerified: true });
    expect(await checkVisibility(bogus, gViewer)).toMatchObject({ ok: false, status: 403 });
    mockUserFindById.mockResolvedValue({ email: 'jo@someone.github.io', emailVerified: true });
    expect(await checkVisibility(bogus, gViewer)).toMatchObject({ ok: false, status: 403 });
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
