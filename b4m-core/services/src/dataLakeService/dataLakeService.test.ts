import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DATA_LAKES,
  UpdateDataLakeRequestInput,
  type AccessContext,
  type IDataLakeDocument,
  type IDataLakeBatchDocument,
} from '@bike4mind/common';
import { canAccessLake, assertLakeAccess, assertLakeWritable, isFallbackLake } from './assertLakeAccess';
import { canManageLake, assertLakeWriteAccess, assertCanWriteDataLakeTags } from './authorizeLakeWrite';
import { createDataLake } from './createDataLake';
import { archiveDataLake } from './archiveDataLake';
import { deleteDataLake } from './deleteDataLake';
import type { RetrievalIndexRemoval } from './ports';
import { unarchiveDataLake } from './unarchiveDataLake';
import { restoreDeletedDataLake } from './restoreDeletedDataLake';
import { cleanupDeletedDataLake } from './cleanupDeletedDataLake';
import { removeFileFromDataLake } from './removeFileFromDataLake';
import { setLakeVisibility } from './setLakeVisibility';
import { updateDataLake } from './updateDataLake';
import { reconcileStuckBatches, DEFAULT_STUCK_BATCH_TIMEOUT_MS } from './reconcileStuckBatches';
import { listDataLakes, listAllDataLakes, listArchivedDataLakes, listDeletedDataLakes } from './listDataLakes';
import { redactLakeForActor, READER_LAKE_FIELDS } from './redactLakeForActor';
import { browsePublicDataLakes } from './browsePublicDataLakes';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

/** The membership scope the `lake()` fixture yields. */
const lakeScope = {
  datalakeTag: 'datalake:lake',
  fileTagPrefix: 'lk:',
  creatorUserId: 'owner',
};

/**
 * What findIdsByDataLakeTag resolves for the `lake()` fixture. The second is the member a
 * meta-tag-keyed removal could never reach; that the Mongo predicate genuinely selects a
 * prefix-only file is proved real-DB in FabFileModel.dataLakeLifecycle.test.ts, not here.
 */
const memberIds = ['meta-tagged-file', 'prefix-only-file'];

const indexPort = (behavior: 'ok' | 'fails' = 'ok') => ({
  removeForDataLake:
    behavior === 'ok'
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('index unreachable')),
});

const removalInput = (port: ReturnType<typeof indexPort>): RetrievalIndexRemoval =>
  port.removeForDataLake.mock.calls[0][0];

const ctx = (overrides: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'someone',
  isAdmin: false,
  userTags: [],
  organizationId: undefined,
  ...overrides,
});

describe('canAccessLake — the single access gate rule', () => {
  it('grants the owner', () => {
    expect(canAccessLake(lake(), ctx({ userId: 'owner' }))).toBe(true);
  });

  it('grants an admin', () => {
    expect(canAccessLake(lake({ requiredUserTag: 'secret', organizationId: 'orgA' }), ctx({ isAdmin: true }))).toBe(
      true
    );
  });

  it('grants a non-owner who satisfies BOTH org and tag', () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgA', userTags: ['opti'] }))).toBe(true);
  });

  it('DENIES a tag-holder in a DIFFERENT org (org is a hard prerequisite, not a flat OR)', () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgB', userTags: ['opti'] }))).toBe(false);
  });

  it('DENIES a same-org user missing the required tag', () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgA', userTags: ['other'] }))).toBe(false);
  });

  it('Private-by-default: a gateless, org-less lake is owner/admin-only', () => {
    const priv = lake(); // no org, no requiredUserTag, no requiredEntitlement
    // Owner and admin still reach it.
    expect(canAccessLake(priv, ctx({ userId: 'owner' }))).toBe(true);
    expect(canAccessLake(priv, ctx({ isAdmin: true }))).toBe(true);
    // Every other caller is denied - this is the single-lake gate matching the rule the
    // collection paths enforce, so a guessed-slug private lake can't be reached.
    expect(canAccessLake(priv, ctx())).toBe(false);
    expect(canAccessLake(priv, ctx({ organizationId: 'orgA', userTags: ['anything'] }))).toBe(false);
  });

  it('Public: an isPublic lake is readable by any caller, cross-org, bypassing Private-by-default', () => {
    // isPublic with NO org and NO gate would be Private-by-default; the public arm must run
    // first so it is readable by everyone, in any org, regardless of tags/keys.
    const pub = lake({ isPublic: true, createdByUserId: 'alice' });
    expect(canAccessLake(pub, ctx({ userId: 'stranger' }))).toBe(true);
    expect(canAccessLake(pub, ctx({ userId: 'stranger', organizationId: 'orgB' }))).toBe(true);
  });

  it('Public + a (post-publish) gate still enforces the gate — defense in depth', () => {
    // Publishing a gated lake is refused by setLakeVisibility, but if a gate is added AFTER
    // publishing, the read gate must still hold: only a key-holder reads it, and org is bypassed.
    const pubGated = lake({ isPublic: true, requiredEntitlement: 'product:pro', createdByUserId: 'alice' });
    expect(canAccessLake(pubGated, ctx({ userId: 'stranger' }))).toBe(false);
    expect(canAccessLake(pubGated, ctx({ userId: 'stranger', entitlementKeys: ['product:pro'] }))).toBe(true);
    // Cross-org key-holder still reads it: public bypasses the org prerequisite.
    expect(
      canAccessLake(pubGated, ctx({ userId: 'stranger', organizationId: 'orgB', entitlementKeys: ['product:pro'] }))
    ).toBe(true);
  });

  it('an entitlement-gated lake is NOT swept up as private — the private rule keys off field PRESENCE', () => {
    // The private-by-default rule denies only lakes with NO org and NO gate. A lake declaring
    // requiredEntitlement has a gate, so the private rule never touches it: a key-holder is
    // granted, while a non-holder is denied by the entitlement gate (lakeMatchesAccess) - NOT
    // by the private rule.
    const gated = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(gated, ctx({ entitlementKeys: ['product:pro'] }))).toBe(true);
    expect(canAccessLake(gated, ctx())).toBe(false);
  });
});

// Generic placeholder keys (product:pro / medlib) - no product literals, to keep this core
// test boundary-clean (the same convention as getAccessibleDataLakes' tests).
describe('canAccessLake — entitlement-aware any-of (tag-retirement)', () => {
  it('grants a non-owner via requiredEntitlement (no tag held — the tag-less subscriber)', () => {
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ entitlementKeys: ['product:pro'] }))).toBe(true);
  });

  it('grants via EITHER the required tag OR the required entitlement (any-of)', () => {
    const l = lake({ requiredUserTag: 'medlib', requiredEntitlement: 'product:pro' });
    // entitlement only
    expect(canAccessLake(l, ctx({ entitlementKeys: ['product:pro'] }))).toBe(true);
    // tag only
    expect(canAccessLake(l, ctx({ userTags: ['medlib'] }))).toBe(true);
  });

  it('matches the required entitlement case-insensitively (normalized)', () => {
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ entitlementKeys: ['Product:Pro'] }))).toBe(true);
  });

  it('treats a lake declaring ONLY requiredEntitlement as NOT public (gated by the key)', () => {
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx())).toBe(false); // no tag, no key
    expect(canAccessLake(l, ctx({ entitlementKeys: ['other:pro'] }))).toBe(false);
  });

  it('DENIES an entitlement-holder in a DIFFERENT org (org stays a hard prerequisite)', () => {
    const l = lake({ organizationId: 'orgA', requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgB', entitlementKeys: ['product:pro'] }))).toBe(false);
  });

  it('grants a same-org entitlement-holder when the lake is org-scoped', () => {
    const l = lake({ organizationId: 'orgA', requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ organizationId: 'orgA', entitlementKeys: ['product:pro'] }))).toBe(true);
  });

  it('no-tag-only-access: holding ONLY the bare tag (not the namespaced :pro key) is denied a :pro-gated lake', () => {
    // The retired-tag invariant, generically: a lake gated by `product:pro` is NOT reachable by
    // a user who holds only the bare `product` tag/key (the 1:1 passthrough) without `product:pro`.
    const l = lake({ requiredEntitlement: 'product:pro' });
    expect(canAccessLake(l, ctx({ userTags: ['product'], entitlementKeys: ['product'] }))).toBe(false);
  });
});

describe('canAccessLake — org id shape parity with the casting collection query', () => {
  // findAccessible matches an org lake via a Mongo query that CASTS types, so an org member
  // whose ctx.organizationId is an ObjectId or a populated Organization doc still lands in the
  // list. canAccessLake compares in memory, so it must reach the SAME grant for every shape -
  // otherwise the single-lake gate 404s a lake the caller's own list returns. Each shape below
  // stands in for the same org value the collection query matched on.
  const orgHex = '507f1f77bcf86cd799439011';
  const orgLake = lake({ id: 'orgLake', organizationId: orgHex, createdByUserId: 'admin' });

  it('grants a same-org member when ctx.organizationId is a matching string', () => {
    expect(canAccessLake(orgLake, ctx({ userId: 'member', organizationId: orgHex }))).toBe(true);
  });

  it('grants a same-org member when ctx.organizationId is an ObjectId', () => {
    const objectId = { toHexString: () => orgHex } as unknown as string;
    expect(canAccessLake(orgLake, ctx({ userId: 'member', organizationId: objectId }))).toBe(true);
  });

  it('grants a same-org member when ctx.organizationId is a populated Organization document', () => {
    const populated = { _id: { toHexString: () => orgHex }, name: 'Acme' } as unknown as string;
    expect(canAccessLake(orgLake, ctx({ userId: 'member', organizationId: populated }))).toBe(true);
  });

  it('still DENIES a member of a different org across every shape', () => {
    const otherHex = '507f191e810c19729de860ea';
    const otherObjectId = { toHexString: () => otherHex } as unknown as string;
    const otherPopulated = { _id: { toHexString: () => otherHex } } as unknown as string;
    expect(canAccessLake(orgLake, ctx({ userId: 'member', organizationId: otherHex }))).toBe(false);
    expect(canAccessLake(orgLake, ctx({ userId: 'member', organizationId: otherObjectId }))).toBe(false);
    expect(canAccessLake(orgLake, ctx({ userId: 'member', organizationId: otherPopulated }))).toBe(false);
  });

  it('fails CLOSED: a lake with a truthy-but-not-id-shaped org and no gate denies a non-owner', () => {
    // Guards the fail-open asymmetry: private-by-default and the org-match check must both read
    // the SAME normalized lake org id. A garbage org (normalizes to undefined) with no gate must
    // deny a non-owner, not fall through to public.
    const garbageOrgLake = lake({
      id: 'garbageOrg',
      organizationId: { not: 'an id' } as unknown as string,
      createdByUserId: 'owner',
    });
    expect(canAccessLake(garbageOrgLake, ctx({ userId: 'member', organizationId: 'orgA' }))).toBe(false);
    expect(canAccessLake(garbageOrgLake, ctx({ userId: 'owner' }))).toBe(true); // owner still in
  });
});

describe('assertLakeAccess — not-found-style denial', () => {
  it('throws a not-found-style error for a denied non-member (does not disclose existence)', async () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(
      assertLakeAccess('lake1', ctx({ organizationId: 'orgB', userTags: ['opti'] }), { db })
    ).rejects.toThrow(/not found/i);
  });

  it('returns the lake on grant', async () => {
    const l = lake();
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(assertLakeAccess('lake1', ctx({ userId: 'owner' }), { db })).resolves.toBe(l);
  });
});

describe('assertLakeAccess — hardcoded fallback lakes (no backing document)', () => {
  // The DB knows nothing: both lookups miss, as they do for the seeded opti-knowledge lake.
  const emptyDb = () => ({
    dataLakes: {
      findById: vi.fn().mockRejectedValue(new Error('bad id')),
      findBySlug: vi.fn().mockResolvedValue(null),
    },
  });

  it('resolves opti-knowledge for a tag-holder as a synthetic read-only lake', async () => {
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ userTags: ['opti'] }), { db: emptyDb() });
    expect(resolved.id).toBe('opti-knowledge');
    expect(resolved.datalakeTag).toBe('datalake:opti-knowledge');
    expect(resolved.fileTagPrefix).toBe('opti:');
    expect(resolved.status).toBe('active');
    expect(resolved.createdByUserId).toBe('');
  });

  it('resolves opti-knowledge for a tag-less entitlement holder (any-of parity with the list path)', async () => {
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ entitlementKeys: ['optihashi:pro'] }), {
      db: emptyDb(),
    });
    expect(resolved.id).toBe('opti-knowledge');
  });

  it('resolves opti-knowledge for an admin without the tag or entitlement', async () => {
    const resolved = await assertLakeAccess('opti-knowledge', ctx({ isAdmin: true }), { db: emptyDb() });
    expect(resolved.id).toBe('opti-knowledge');
  });

  it('still denies (not-found-style) a caller who satisfies neither gate', async () => {
    await expect(assertLakeAccess('opti-knowledge', ctx(), { db: emptyDb() })).rejects.toThrow(/not found/i);
  });

  it('a DB lake shadowing a fallback slug takes precedence over the fallback', async () => {
    const dbLake = lake({ id: 'real-id', slug: 'opti-knowledge', createdByUserId: 'owner' });
    const db = {
      dataLakes: {
        findById: vi.fn().mockRejectedValue(new Error('bad id')),
        findBySlug: vi.fn().mockResolvedValue(dbLake),
      },
    };
    await expect(assertLakeAccess('opti-knowledge', ctx({ userId: 'owner' }), { db })).resolves.toBe(dbLake);
  });

  it('a denied DB lake shadowing a fallback slug is FINAL — no fallback retry around the denial', async () => {
    const dbLake = lake({ id: 'real-id', slug: 'opti-knowledge', createdByUserId: 'owner', organizationId: 'orgA' });
    const db = {
      dataLakes: {
        findById: vi.fn().mockRejectedValue(new Error('bad id')),
        findBySlug: vi.fn().mockResolvedValue(dbLake),
      },
    };
    await expect(
      assertLakeAccess('opti-knowledge', ctx({ userTags: ['opti'], organizationId: 'orgB' }), { db })
    ).rejects.toThrow(/not found/i);
  });
});

describe('assertLakeWritable / isFallbackLake — fallback lakes are read-only', () => {
  it('identifies a fallback lake by config id and refuses the write with a clear read-only error', () => {
    expect(isFallbackLake({ id: 'opti-knowledge' })).toBe(true);
    expect(() => assertLakeWritable({ id: 'opti-knowledge' })).toThrow(/read-only/i);
  });

  it('passes a persisted (ObjectId-style) lake through untouched', () => {
    expect(isFallbackLake({ id: '507f1f77bcf86cd799439011' })).toBe(false);
    expect(() => assertLakeWritable({ id: '507f1f77bcf86cd799439011' })).not.toThrow();
  });
});

describe('canManageLake — the single write/manage rule (creator or admin)', () => {
  it('grants the creator', () => {
    expect(canManageLake(lake({ createdByUserId: 'owner' }), { userId: 'owner', isAdmin: false })).toBe(true);
  });

  it('grants any admin (even a non-creator)', () => {
    expect(canManageLake(lake({ createdByUserId: 'owner' }), { userId: 'other', isAdmin: true })).toBe(true);
  });

  it('denies a non-creator non-admin — even one who can READ via a tag grant', () => {
    // The read gate (canAccessLake) would grant this caller, but write must not.
    const gated = lake({ createdByUserId: 'owner', requiredUserTag: 'Opti' });
    expect(canAccessLake(gated, ctx({ userId: 'reader', userTags: ['opti'] }))).toBe(true);
    expect(canManageLake(gated, { userId: 'reader', isAdmin: false })).toBe(false);
  });

  it('denies a stranger on a PUBLIC lake — the read-can-write asymmetry now that public grants read', () => {
    // A public lake grants READ to any caller (canAccessLake true), but managing it stays
    // owner/admin only. Pins the asymmetry for the new public surface.
    const pub = lake({ createdByUserId: 'alice', isPublic: true });
    expect(canAccessLake(pub, ctx({ userId: 'stranger' }))).toBe(true);
    expect(canManageLake(pub, { userId: 'stranger', isAdmin: false })).toBe(false);
  });
});

describe('canManageLake - fails closed on a blank identity', () => {
  it('denies an actor with no userId on an owner-less lake, rather than matching blank to blank', () => {
    // The synthetic fallback document carries createdByUserId: ''. A bare === would have granted
    // manage (and, since this predicate now gates prompt disclosure, the prompt with it).
    expect(canManageLake(lake({ createdByUserId: '' }), { userId: '', isAdmin: false })).toBe(false);
    expect(
      canManageLake({ createdByUserId: undefined } as unknown as IDataLakeDocument, {
        userId: undefined as unknown as string,
        isAdmin: false,
      })
    ).toBe(false);
  });

  it('still grants an admin on an owner-less lake', () => {
    expect(canManageLake(lake({ createdByUserId: '' }), { userId: '', isAdmin: true })).toBe(true);
  });
});

describe('listDataLakes - per-lake canManage flag for the UI', () => {
  it("marks the caller's own lakes manageable and strangers' (public) lakes read-only", async () => {
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'me' });
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'other', isPublic: true });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([mine, theirs]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });

    expect(result.find(l => l.id === 'mine')?.canManage).toBe(true);
    expect(result.find(l => l.id === 'theirs')?.canManage).toBe(false);
  });

  it('marks every DB lake manageable for an admin', async () => {
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'other' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([theirs]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });

    expect(result.find(l => l.id === 'theirs')?.canManage).toBe(true);
  });

  it('marks built-in fallback lakes read-only even for their access holders', async () => {
    // No DB lakes; the Opti-gated fallback surfaces because the caller holds the tag. It has no
    // backing document (assertLakeWritable refuses it), so it must never be manageable.
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'me', userTags: ['Opti'] }), { db });
    const fallback = result.find(l => l.id === 'opti-knowledge');

    expect(fallback).toBeDefined();
    expect(fallback?.canManage).toBe(false);
  });
});

// systemPrompt is EDITOR-ONLY: it steers every answer drawn from the lake, but only the lake's
// creator or an admin may read the wording. The list endpoint is where the editor UI gets the
// value to seed its form, and it is also the endpoint that surfaces strangers' public lakes.
describe('listDataLakes - systemPrompt is returned to a lake EDITOR only', () => {
  const withPrompt = (overrides: Partial<IDataLakeDocument>) =>
    lake({ systemPrompt: 'Always cite the source file.', ...overrides });

  it("returns the prompt for the caller's own lake (seeds the Settings editor)", async () => {
    const mine = withPrompt({ id: 'mine', slug: 'mine', createdByUserId: 'me' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([mine]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });

    expect(result.find(l => l.id === 'mine')?.systemPrompt).toBe('Always cite the source file.');
  });

  it("WITHHOLDS the prompt from a stranger reading someone else's PUBLIC lake", async () => {
    const theirs = withPrompt({ id: 'theirs', slug: 'theirs', createdByUserId: 'other', isPublic: true });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([theirs]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'stranger' }), { db });
    const entry = result.find(l => l.id === 'theirs');

    expect(entry?.canManage).toBe(false);
    expect(entry?.systemPrompt).toBeUndefined();
    // Absent, not blanked: the client must not be able to tell "unset" from "withheld".
    expect(entry && 'systemPrompt' in entry).toBe(false);
  });

  it('WITHHOLDS the prompt from a non-owner ORG member (read access is not manage access)', async () => {
    const theirs = withPrompt({ id: 'org', slug: 'org', createdByUserId: 'other', organizationId: 'orgA' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([theirs]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'member', organizationId: 'orgA' }), { db });

    expect(result.find(l => l.id === 'org')?.systemPrompt).toBeUndefined();
  });

  it("returns the prompt to an admin on another user's lake (admin is an editor)", async () => {
    const theirs = withPrompt({ id: 'theirs', slug: 'theirs', createdByUserId: 'other' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([theirs]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'admin', isAdmin: true }), { db });

    expect(result.find(l => l.id === 'theirs')?.systemPrompt).toBe('Always cite the source file.');
  });

  it('omits a whitespace-only prompt so the client never distinguishes blank from unset', async () => {
    const mine = lake({ id: 'mine', slug: 'mine', createdByUserId: 'me', systemPrompt: '   \n ' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([mine]), find: vi.fn() } };

    const result = await listDataLakes(ctx({ userId: 'me' }), { db });

    expect(result.find(l => l.id === 'mine')?.systemPrompt).toBeUndefined();
  });
});

describe('listAllDataLakes - the admin list still gates the prompt on canManage', () => {
  it('returns the prompt on every DB lake, since an admin manages them all', async () => {
    const theirs = lake({ id: 'theirs', slug: 'theirs', createdByUserId: 'other', systemPrompt: 'Cite sources.' });
    const db = { dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([theirs]) } };

    const result = await listAllDataLakes({ db });

    // Pins the manage flag AND the disclosure it now gates: flipping this projection to
    // canManage:false would silently strip prompts from every admin and break the admin editor.
    expect(result.find(l => l.id === 'theirs')?.canManage).toBe(true);
    expect(result.find(l => l.id === 'theirs')?.systemPrompt).toBe('Cite sources.');
  });

  it('never carries a prompt on a built-in fallback lake, whatever the registry holds', async () => {
    const db = { dataLakes: { findAccessible: vi.fn(), find: vi.fn().mockResolvedValue([]) } };

    const result = await listAllDataLakes({ db });
    const fallback = result.find(l => l.id === 'opti-knowledge');

    // The registry is JSON.parse'd from env and keeps unknown keys, so an overlay entry could
    // arrive carrying a systemPrompt. Routing fallbacks through the projection is what stops it.
    expect(fallback).toBeDefined();
    expect(fallback?.canManage).toBe(false);
    expect(fallback && 'systemPrompt' in fallback).toBe(false);
  });
});

// The raw-document exits (GET /api/data-lakes/:id, /archived, /deleted) are gated on READ
// access, which is deliberately wider than manage - so each one must redact before serializing.
// The redaction is an ALLOW-LIST (toReaderLake): a non-editor receives only the named fields, so
// a field added to IDataLake later is withheld by default rather than shipped.
describe('redactLakeForActor - editor-only fields on the raw-document exits', () => {
  const prompted = (overrides: Partial<IDataLakeDocument> = {}) =>
    lake({ createdByUserId: 'owner', systemPrompt: 'Answer only from this lake.', ...overrides });

  it('leaves the document untouched for the owner', () => {
    const l = prompted();
    expect(redactLakeForActor(l, { userId: 'owner', isAdmin: false })).toBe(l);
  });

  it('leaves the document untouched for an admin', () => {
    const l = prompted();
    const visible = redactLakeForActor(l, { userId: 'admin', isAdmin: true });
    expect(visible).toBe(l);
    expect((visible as IDataLakeDocument).systemPrompt).toBe('Answer only from this lake.');
  });

  it('strips the prompt for a stranger who can READ a published lake', () => {
    const l = prompted({ isPublic: true });
    const visible = redactLakeForActor(l, { userId: 'stranger', isAdmin: false }) as IDataLakeDocument;

    expect(visible.systemPrompt).toBeUndefined();
    expect('systemPrompt' in visible).toBe(false);
    // Everything a reader is entitled to must survive the redaction.
    expect(visible.name).toBe('Lake');
    expect(visible.datalakeTag).toBe('datalake:lake');
  });

  it('serves a stranger ONLY the allow-listed fields, never an unlisted one', () => {
    // An extra own-enumerable key (as a hydrated document could carry) must not pass through: the
    // allow-list emits named fields only, so the deny-list's "unlisted field leaks" failure is gone.
    const l = prompted({ isPublic: true, secretField: 'leak-me' } as unknown as Partial<IDataLakeDocument>);
    const visible = redactLakeForActor(l, { userId: 'stranger', isAdmin: false });

    expect('secretField' in visible).toBe(false);
    expect('systemPrompt' in visible).toBe(false);
    expect(Object.keys(visible).every(k => (READER_LAKE_FIELDS as readonly string[]).includes(k))).toBe(true);
  });

  it('reports a whitespace-only prompt as absent for the OWNER too, matching the list projection', () => {
    // Without this the same lake reads as "has a prompt" on GET /:id and "has none" in the list.
    const blank = lake({ createdByUserId: 'owner', systemPrompt: '   \n ' });
    const visible = redactLakeForActor(blank, { userId: 'owner', isAdmin: false });
    expect('systemPrompt' in visible).toBe(false);
  });

  it('reports an EMPTY-STRING prompt as absent for the OWNER, like the list projection does', () => {
    // '' must be normalized identically to whitespace: the list omits it (''?.trim() is falsy), so
    // GET /:id must not echo it back as a present-but-empty field for an editor.
    const empty = lake({ createdByUserId: 'owner', systemPrompt: '' });
    const visible = redactLakeForActor(empty, { userId: 'owner', isAdmin: false });
    expect('systemPrompt' in visible).toBe(false);
  });

  it('trims a padded-but-non-blank prompt for the OWNER, matching the list projection', () => {
    // GET /:id must not echo stored padding an editor never typed while the list sends it trimmed.
    const padded = lake({ createdByUserId: 'owner', systemPrompt: '  Cite the source.  ' });
    const visible = redactLakeForActor(padded, { userId: 'owner', isAdmin: false }) as IDataLakeDocument;
    expect(visible.systemPrompt).toBe('Cite the source.');
    // A copy, not the source - the padded original is left intact for any write path still holding it.
    expect(visible).not.toBe(padded);
    expect(padded.systemPrompt).toBe('  Cite the source.  ');
  });

  it('treats a null prompt as blank for an editor rather than throwing on .trim()', () => {
    // Only a direct DB write or migration produces null; the predicate must stay null-safe regardless.
    const nulled = lake({ createdByUserId: 'owner', systemPrompt: null as unknown as string });
    const visible = redactLakeForActor(nulled, { userId: 'owner', isAdmin: false });
    expect('systemPrompt' in visible).toBe(false);
  });

  it('pins the reader allow-list so a new IDataLake field forces a visibility decision', () => {
    // If this fails, a field was added to IDataLake (or READER_LAKE_FIELDS changed) without deciding
    // whether a non-editor may receive it. Add it to READER_LAKE_FIELDS on purpose, or leave it out.
    expect([...READER_LAKE_FIELDS].sort()).toEqual(
      [
        'createdAt',
        'createdByUserId',
        'datalakeTag',
        'description',
        'fileCount',
        'fileTagPrefix',
        'id',
        'isPublic',
        'lastSyncAt',
        'name',
        'organizationId',
        'requiredEntitlement',
        'requiredUserTag',
        'slug',
        'status',
        'totalSizeBytes',
        'updatedAt',
      ].sort()
    );
    expect((READER_LAKE_FIELDS as readonly string[]).includes('systemPrompt')).toBe(false);
  });

  it('does not mutate the source document (the caller may still hold it for a write path)', () => {
    const l = prompted({ isPublic: true });
    redactLakeForActor(l, { userId: 'stranger', isAdmin: false });
    expect(l.systemPrompt).toBe('Answer only from this lake.');
  });

  it('redacts per lake in the archived management view', async () => {
    const mine = prompted({ id: 'mine', slug: 'mine', createdByUserId: 'me' });
    const orgLake = prompted({ id: 'org', slug: 'org', createdByUserId: 'other', organizationId: 'orgA' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([mine, orgLake]), find: vi.fn() } };

    const result = await listArchivedDataLakes(ctx({ userId: 'me', organizationId: 'orgA' }), { db });

    expect((result.find(l => l.id === 'mine') as IDataLakeDocument)?.systemPrompt).toBe('Answer only from this lake.');
    // Key absence, not undefined: blanking instead of deleting would pass the weaker assertion.
    const redactedArchived = result.find(l => l.id === 'org')!;
    expect('systemPrompt' in redactedArchived).toBe(false);
  });

  it('redacts per lake in the deleted management view', async () => {
    const orgLake = prompted({ id: 'org', slug: 'org', createdByUserId: 'other', organizationId: 'orgA' });
    const db = { dataLakes: { findAccessible: vi.fn().mockResolvedValue([orgLake]), find: vi.fn() } };

    const result = await listDeletedDataLakes(ctx({ userId: 'me', organizationId: 'orgA' }), { db });

    expect('systemPrompt' in result[0]!).toBe(false);
  });
});

describe('assertLakeWriteAccess — read-then-manage gate for the upload doors', () => {
  it('returns the lake for the creator', async () => {
    const l = lake({ createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(assertLakeWriteAccess('lake1', ctx({ userId: 'owner' }), { db })).resolves.toBe(l);
  });

  it('not-found for a caller who cannot even read the lake (no existence leak)', async () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti', createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(
      assertLakeWriteAccess('lake1', ctx({ userId: 'x', organizationId: 'orgB', userTags: ['opti'] }), { db })
    ).rejects.toThrow(/not found/i);
  });

  it('manage-denied for a reader who is not the creator (the manage-access asymmetry)', async () => {
    const l = lake({ organizationId: 'orgA', requiredUserTag: 'Opti', createdByUserId: 'owner' });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(
      assertLakeWriteAccess('lake1', ctx({ userId: 'reader', organizationId: 'orgA', userTags: ['opti'] }), { db })
    ).rejects.toThrow(/creator/i);
  });

  it('manage-denied for a stranger on a PUBLIC lake — read passes the gate, write must not', async () => {
    const l = lake({ createdByUserId: 'owner', isPublic: true });
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), findBySlug: vi.fn() } };
    await expect(assertLakeWriteAccess('lake1', ctx({ userId: 'stranger' }), { db })).rejects.toThrow(/creator/i);
  });

  it('refuses a fallback lake as read-only even for an admin (no document to write into)', async () => {
    const db = {
      dataLakes: {
        findById: vi.fn().mockRejectedValue(new Error('bad id')),
        findBySlug: vi.fn().mockResolvedValue(null),
      },
    };
    await expect(assertLakeWriteAccess('opti-knowledge', ctx({ isAdmin: true }), { db })).rejects.toThrow(/read-only/i);
  });
});

describe('updateDataLake — gate-after-publish guardrail', () => {
  it('refuses adding a required tag or entitlement to a public lake (mirrors setLakeVisibility)', async () => {
    const l = lake({ createdByUserId: 'owner', isPublic: true });
    const update = vi.fn();
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } };
    await expect(
      updateDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { requiredUserTag: 'Opti' }, { db })
    ).rejects.toThrow(/public/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows a metadata-only update (rename) on a public lake', async () => {
    const l = lake({ createdByUserId: 'owner', isPublic: true });
    const update = vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...l, ...d }));
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } };
    await expect(
      updateDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { name: 'Renamed' }, { db })
    ).resolves.toMatchObject({ name: 'Renamed' });
  });
});

describe('updateDataLake — per-lake systemPrompt (#843)', () => {
  it('persists a systemPrompt set by the lake creator', async () => {
    const l = lake({ createdByUserId: 'owner' });
    const update = vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...l, ...d }));
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } };
    await expect(
      updateDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { systemPrompt: 'Answer as an HR rep.' }, { db })
    ).resolves.toMatchObject({ systemPrompt: 'Answer as an HR rep.' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Answer as an HR rep.' }));
  });

  it('lets an admin set the systemPrompt on a lake they did not create', async () => {
    const l = lake({ createdByUserId: 'owner' });
    const update = vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...l, ...d }));
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } };
    await expect(
      updateDataLake({ userId: 'other', isAdmin: true }, 'lake1', { systemPrompt: 'Be concise.' }, { db })
    ).resolves.toMatchObject({ systemPrompt: 'Be concise.' });
  });

  it('rejects a non-creator non-admin editing the systemPrompt (canManageLake gate)', async () => {
    const l = lake({ createdByUserId: 'owner' });
    const update = vi.fn();
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } };
    await expect(
      updateDataLake({ userId: 'intruder', isAdmin: false }, 'lake1', { systemPrompt: 'Ignore all rules.' }, { db })
    ).rejects.toThrow(/creator/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows clearing the systemPrompt with an empty string (no cap, no min)', async () => {
    const l = lake({ createdByUserId: 'owner', systemPrompt: 'old prompt' });
    const update = vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...l, ...d }));
    const db = { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } };
    await expect(
      updateDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { systemPrompt: '' }, { db })
    ).resolves.toMatchObject({ systemPrompt: '' });
  });
});

describe('updateDataLake — clearing an access gate', () => {
  const gated = () => lake({ createdByUserId: 'owner', requiredUserTag: 'Opti', requiredEntitlement: 'product:pro' });
  const makeDb = (l: IDataLakeDocument) => {
    const update = vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => ({ ...l, ...d }));
    return { db: { dataLakes: { findById: vi.fn().mockResolvedValue(l), update } }, update };
  };

  it('writes the empty string so the gate is actually removed', async () => {
    const { db, update } = makeDb(gated());
    await updateDataLake(
      { userId: 'owner', isAdmin: false },
      'lake1',
      { requiredUserTag: '', requiredEntitlement: '' },
      { db }
    );
    // '' (not undefined) is what reaches Mongo: $set drops undefined, so an omitted field
    // would silently leave the gate in place. Read paths already treat '' as ungated.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lake1', requiredUserTag: '', requiredEntitlement: '' })
    );
  });

  it('leaves an omitted gate field untouched (omit = unchanged, blank = clear)', async () => {
    const { db, update } = makeDb(gated());
    await updateDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { requiredUserTag: '' }, { db });
    const written = update.mock.calls[0][0];
    expect(written).toMatchObject({ requiredUserTag: '' });
    expect(written).not.toHaveProperty('requiredEntitlement');
  });

  it('lets an admin clear a gate on someone else’s lake, and refuses a non-owner', async () => {
    const { db, update } = makeDb(gated());
    await expect(
      updateDataLake({ userId: 'admin', isAdmin: true }, 'lake1', { requiredUserTag: '' }, { db })
    ).resolves.toMatchObject({ requiredUserTag: '' });

    const other = makeDb(gated());
    await expect(
      updateDataLake({ userId: 'stranger', isAdmin: false }, 'lake1', { requiredUserTag: '' }, { db: other.db })
    ).rejects.toThrow(/only the creator/i);
    expect(other.update).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('clearing a gate on a public lake is allowed (the guardrail only blocks ADDING one)', async () => {
    const { db } = makeDb(lake({ createdByUserId: 'owner', isPublic: true, requiredUserTag: 'Opti' }));
    await expect(
      updateDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { requiredUserTag: '' }, { db })
    ).resolves.toMatchObject({ requiredUserTag: '' });
  });

  it('an ungated, org-less lake is owner-only — clearing does not make it world-readable', async () => {
    const cleared = lake({ createdByUserId: 'owner', requiredUserTag: '', requiredEntitlement: '' });
    expect(canAccessLake(cleared, ctx({ userId: 'stranger' }))).toBe(false);
    expect(canAccessLake(cleared, ctx({ userId: 'owner' }))).toBe(true);
  });
});

describe('UpdateDataLakeRequestInput — gate clear sentinel', () => {
  it('accepts the empty string for both gate fields', () => {
    const parsed = UpdateDataLakeRequestInput.parse({ requiredUserTag: '', requiredEntitlement: '' });
    expect(parsed).toEqual({ requiredUserTag: '', requiredEntitlement: '' });
  });

  it('still rejects a non-namespaced entitlement (the sentinel is not a validation hole)', () => {
    expect(() => UpdateDataLakeRequestInput.parse({ requiredEntitlement: 'pro' })).toThrow();
  });
});

describe('assertCanWriteDataLakeTags — gate on the file-tag write paths', () => {
  const makeDb = (found: IDataLakeDocument | null) => ({
    dataLakes: { findByDatalakeTag: vi.fn().mockResolvedValue(found) },
  });

  it('ignores non-meta tags entirely (no lookup, no throw)', async () => {
    const db = makeDb(null);
    await expect(
      assertCanWriteDataLakeTags({ userId: 'anyone', isAdmin: false }, ['acme:sales', 'notes'], { db })
    ).resolves.toBeUndefined();
    expect(db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('allows the creator to apply the lake meta-tag', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['datalake:lake'], { db })
    ).resolves.toBeUndefined();
  });

  it('allows an admin to apply the lake meta-tag', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await expect(
      assertCanWriteDataLakeTags({ userId: 'other', isAdmin: true }, ['datalake:lake'], { db })
    ).resolves.toBeUndefined();
  });

  it('rejects a read-only member injecting into a lake they do not own', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await expect(
      assertCanWriteDataLakeTags({ userId: 'reader', isAdmin: false }, ['datalake:lake'], { db })
    ).rejects.toThrow(/creator/i);
  });

  it('rejects a meta-tag that resolves to no lake (forged/stale tag)', async () => {
    const db = makeDb(null);
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['datalake:ghost'], { db })
    ).rejects.toThrow(/creator/i);
  });

  it('tolerates malformed (non-string) tag entries — fails closed as 400, never a TypeError', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    // A raw, un-validated payload with null/number/object entries must not crash the guard.
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, [null, undefined, 42, {}, 'notes'] as unknown[], {
        db,
      })
    ).resolves.toBeUndefined();
    expect(db.dataLakes.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('normalizes a mixed-case meta-tag to its canonical (lowercase) lake key before lookup', async () => {
    const db = makeDb(lake({ createdByUserId: 'owner', datalakeTag: 'datalake:lake' }));
    await assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['DataLake:Lake'], { db });
    expect(db.dataLakes.findByDatalakeTag).toHaveBeenCalledWith('datalake:lake');
  });

  it('rejects when ANY meta-tag among several is unauthorized (mixed batch)', async () => {
    const db = {
      dataLakes: {
        findByDatalakeTag: vi.fn(async (tag: string) =>
          tag === 'datalake:mine'
            ? lake({ createdByUserId: 'owner', datalakeTag: 'datalake:mine' })
            : lake({ createdByUserId: 'someone-else', datalakeTag: 'datalake:theirs' })
        ),
      },
    };
    await expect(
      assertCanWriteDataLakeTags({ userId: 'owner', isAdmin: false }, ['datalake:mine', 'datalake:theirs'], { db })
    ).rejects.toThrow(/creator/i);
  });
});

describe('createDataLake', () => {
  it('creates the lake in DRAFT status (draft -> active is implicit on first batch)', async () => {
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    const db = { dataLakes: { create, find: vi.fn().mockResolvedValue([]) } };
    await createDataLake('owner', { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' }, { db });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('refuses a tag prefix that overlaps a lake in scope, before touching the slug', async () => {
    // The helper is unit-tested separately; this proves createDataLake actually calls it. Deleting
    // the guard makes this pass a create through, so the assertion kills the mutant.
    const create = vi.fn();
    const find = vi.fn().mockResolvedValue([lake({ id: 'other', name: 'Sibling', fileTagPrefix: 'xy:' })]);
    await expect(
      createDataLake('owner', { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' }, { db: { dataLakes: { create, find } } })
    ).rejects.toThrow(/overlaps an existing data lake/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('names the clashing lake only when the caller created it', async () => {
    // An org lake gated by a tag the caller lacks is invisible to them everywhere else, so echoing
    // its name here would confirm it exists.
    const theirs = lake({ id: 'other', name: 'Project Zephyr', fileTagPrefix: 'xy:', createdByUserId: 'someone-else' });
    const find = vi.fn().mockResolvedValue([theirs]);
    await expect(
      createDataLake(
        'owner',
        { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' },
        { db: { dataLakes: { create: vi.fn(), find } } },
        'orgA'
      )
    ).rejects.toThrow(/overlaps an existing data lake in this organization/i);

    const mine = lake({ id: 'other', name: 'My Other Lake', fileTagPrefix: 'xy:', createdByUserId: 'owner' });
    await expect(
      createDataLake(
        'owner',
        { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' },
        { db: { dataLakes: { create: vi.fn(), find: vi.fn().mockResolvedValue([mine]) } } }
      )
    ).rejects.toThrow(/"My Other Lake"/);
  });

  it('allows a prefix that only collides outside the create scope', async () => {
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    // find() answers the scoped query, so an out-of-scope lake simply is not in the result.
    const find = vi.fn().mockResolvedValue([]);
    await createDataLake(
      'owner',
      { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' },
      { db: { dataLakes: { create, find } } }
    );
    expect(create).toHaveBeenCalled();
  });

  it('scopes the meta-tag by org and disambiguates a slug collision deterministically', async () => {
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    // Call order: the tag-prefix availability check, then the slug probes - first slug taken,
    // second free. `lake()` uses prefix `lk:`, which cannot collide with this lake's `xy:`.
    const find = vi.fn().mockResolvedValueOnce([lake()]).mockResolvedValueOnce([lake()]).mockResolvedValueOnce([]);
    const db = { dataLakes: { create, find } };
    // org comes from the principal (4th arg), never the request body.
    await createDataLake('owner', { name: 'X', slug: 'xy', fileTagPrefix: 'xy:' }, { db }, 'orgA');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'xy-1', datalakeTag: 'datalake:orgA:xy-1' }));
  });

  it('refuses to mint a meta-tag the static registry owns, even though no document holds it', () => {
    // The meta-tag is an ownership bypass downstream, and the registry has no Mongo row for
    // the unique index to collide with - so a lake slugged after a registry lake would read
    // every tenant's files in it.
    const registrySlug = DATA_LAKES[0].slug;
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    const db = { dataLakes: { create, find: vi.fn().mockResolvedValue([]) } };

    return createDataLake('mallory', { name: 'X', slug: registrySlug, fileTagPrefix: 'mine:' }, { db }).then(() => {
      const written = create.mock.calls[0][0] as IDataLakeDocument;
      expect(written.datalakeTag).not.toBe(DATA_LAKES[0].datalakeTag);
      expect(written.slug).toBe(`${registrySlug}-1`);
    });
  });

  it('still allows a registry slug inside an org, where the minted tag cannot collide', async () => {
    // An org lake mints `datalake:<org>:<slug>`, which no registry entry can equal.
    const registrySlug = DATA_LAKES[0].slug;
    const create = vi.fn().mockImplementation(async (d: IDataLakeDocument) => d);
    const db = { dataLakes: { create, find: vi.fn().mockResolvedValue([]) } };

    await createDataLake('owner', { name: 'X', slug: registrySlug, fileTagPrefix: 'mine:' }, { db }, 'orgA');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ slug: registrySlug }));
  });
});

describe('unarchiveDataLake — dedup pass (live re-upload wins)', () => {
  it('discards archived duplicates and restores the rest', async () => {
    const archived = [
      { id: 'a1', contentHash: 'h1' },
      { id: 'a2', contentHash: 'h2' },
    ];
    const fabFiles = {
      findArchivedByDataLakeTag: vi.fn().mockResolvedValue(archived),
      // a live file with hash h1 exists (re-uploaded while archived) -> a1 is a dup.
      findByContentHashesInDataLake: vi.fn().mockResolvedValue([{ id: 'live1', contentHash: 'h1' }]),
      unarchiveByDataLakeTag: vi.fn().mockResolvedValue(1),
      deleteManyInIds: vi.fn().mockResolvedValue(undefined),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10 }),
    };
    const dataLakes = {
      findById: vi.fn().mockResolvedValue(lake({ status: 'archived' })),
      update: vi.fn().mockResolvedValue(lake()),
      setStats: vi.fn().mockResolvedValue(lake()),
    };
    const result = await unarchiveDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
      db: { dataLakes, fabFiles },
    });
    // The dedup probe stays on the bare meta-tag: it decides which copy gets hard-deleted, and
    // fileTagPrefix is not unique, so a widened probe could nominate another lake's file.
    expect(fabFiles.findByContentHashesInDataLake).toHaveBeenCalledWith(['h1', 'h2'], 'datalake:lake');
    expect(fabFiles.unarchiveByDataLakeTag).toHaveBeenCalledWith(lakeScope);
    expect(fabFiles.deleteManyInIds).toHaveBeenCalledWith(['a1']);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.restoredCount).toBe(1);
  });
});

describe('restoreDeletedDataLake — deleted→active with dedup', () => {
  it('rejects a lake that is not soft-deleted', async () => {
    const dataLakes = {
      findById: vi.fn().mockResolvedValue(lake({ status: 'active' })),
      update: vi.fn(),
      setStats: vi.fn(),
    };
    const fabFiles = {
      findDeletedByDataLakeTag: vi.fn(),
      findByContentHashesInDataLake: vi.fn(),
      undeleteByDataLakeTag: vi.fn(),
      computeDataLakeStats: vi.fn(),
    };
    await expect(
      restoreDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { db: { dataLakes, fabFiles } })
    ).rejects.toThrow(/'active' status/i);
  });

  it('un-deletes non-duplicates and excludes live-re-upload duplicates', async () => {
    const deleted = [
      { id: 'd1', contentHash: 'h1' },
      { id: 'd2', contentHash: 'h2' },
    ];
    const fabFiles = {
      findDeletedByDataLakeTag: vi.fn().mockResolvedValue(deleted),
      // a live file with hash h1 exists -> d1 is a dup and must be excluded from un-delete.
      findByContentHashesInDataLake: vi.fn().mockResolvedValue([{ id: 'live1', contentHash: 'h1' }]),
      undeleteByDataLakeTag: vi.fn().mockResolvedValue(1),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 1, totalSizeBytes: 10 }),
    };
    const dataLakes = {
      findById: vi.fn().mockResolvedValue(lake({ status: 'deleted' })),
      update: vi.fn().mockResolvedValue(lake()),
      setStats: vi.fn().mockResolvedValue(lake()),
    };
    const result = await restoreDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
      db: { dataLakes, fabFiles },
    });
    expect(fabFiles.undeleteByDataLakeTag).toHaveBeenCalledWith(lakeScope, ['d1']);
    // Same narrow probe as the unarchive path, for the same reason.
    expect(fabFiles.findByContentHashesInDataLake).toHaveBeenCalledWith(['h1', 'h2'], 'datalake:lake');
    expect(result.skippedDuplicates).toBe(1);
    expect(result.restoredCount).toBe(1);
  });
});

describe('archiveDataLake - retrieval-index removal', () => {
  const makeAdapters = () => ({
    db: {
      dataLakes: {
        findById: vi.fn().mockResolvedValue(lake()),
        update: vi
          .fn()
          .mockImplementation(async ({ status }: { status: IDataLakeDocument['status'] }) => lake({ status })),
        setStats: vi.fn().mockResolvedValue(undefined),
        find: vi.fn().mockResolvedValue([]),
      },
      batches: {
        findActiveByDataLakeId: vi.fn().mockResolvedValue([]),
        markTerminalIfActive: vi.fn().mockResolvedValue(undefined),
      },
      fabFiles: {
        archiveByDataLakeTag: vi.fn().mockResolvedValue(2),
        computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }),
        findIdsByDataLakeTag: vi.fn().mockResolvedValue(memberIds),
      },
    },
    logger: { warn: vi.fn() },
  });

  it('hands the index the whole membership scope and every member id', async () => {
    const adapters = makeAdapters();
    const retrievalIndex = indexPort();
    await archiveDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, retrievalIndex });

    // The scope, not the meta-tag: stripped of fileTagPrefix and creatorUserId an implementer
    // cannot reach the prefix-only member the sweep just archived.
    expect(removalInput(retrievalIndex)).toEqual({ scope: lakeScope, fabFileIds: memberIds });
    expect(removalInput(retrievalIndex).fabFileIds).toContain('prefix-only-file');
  });

  it('still settles the lake to archived when the index removal throws', async () => {
    const adapters = makeAdapters();
    await expect(
      archiveDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
        ...adapters,
        retrievalIndex: indexPort('fails'),
      })
    ).resolves.toMatchObject({ status: 'archived' });
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Best-effort index removal failed for datalake:lake'),
      expect.any(Error)
    );
  });

  it('resolves no member ids when no index is wired', async () => {
    const adapters = makeAdapters();
    await archiveDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters);
    expect(adapters.db.fabFiles.findIdsByDataLakeTag).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.archiveByDataLakeTag).toHaveBeenCalledWith(lakeScope);
  });

  it('survives a member-id lookup that itself fails', async () => {
    const adapters = makeAdapters();
    // The resolver is lazy and inside the try precisely so this cannot abort a best-effort op.
    adapters.db.fabFiles.findIdsByDataLakeTag = vi.fn().mockRejectedValue(new Error('mongo down'));
    await expect(
      archiveDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, retrievalIndex: indexPort() })
    ).resolves.toMatchObject({ status: 'archived' });
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Best-effort index removal failed for datalake:lake'),
      expect.any(Error)
    );
  });
});

describe('deleteDataLake - phase 1 retrieval-index removal', () => {
  const makeAdapters = () => ({
    db: {
      dataLakes: {
        findById: vi.fn().mockResolvedValue(lake()),
        update: vi
          .fn()
          .mockImplementation(async ({ status }: { status: IDataLakeDocument['status'] }) => lake({ status })),
        find: vi.fn().mockResolvedValue([]),
      },
      batches: {
        findActiveByDataLakeId: vi.fn().mockResolvedValue([]),
        markTerminalIfActive: vi.fn().mockResolvedValue(undefined),
      },
      fabFiles: {
        // Empty is the re-run shape - a crashed prior attempt already flipped these files, so the
        // flip reports nothing. Sourcing ids from it would send the index an empty set.
        softDeleteByDataLakeTag: vi.fn().mockResolvedValue([]),
        findIdsByDataLakeTag: vi.fn().mockResolvedValue(memberIds),
      },
    },
    logger: { warn: vi.fn() },
  });

  it('hands the index every member id even when the soft-delete flipped nothing', async () => {
    const adapters = makeAdapters();
    const retrievalIndex = indexPort();
    await deleteDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, retrievalIndex });

    expect(removalInput(retrievalIndex)).toEqual({ scope: lakeScope, fabFileIds: memberIds });
    expect(removalInput(retrievalIndex).fabFileIds).toContain('prefix-only-file');
  });

  it('still settles the lake to deleted when the index removal throws', async () => {
    const adapters = makeAdapters();
    await expect(
      deleteDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
        ...adapters,
        retrievalIndex: indexPort('fails'),
      })
    ).resolves.toMatchObject({ status: 'deleted' });
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Best-effort index removal failed for datalake:lake'),
      expect.any(Error)
    );
  });

  it('resolves no member ids when no index is wired', async () => {
    const adapters = makeAdapters();
    await deleteDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters);
    expect(adapters.db.fabFiles.findIdsByDataLakeTag).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.softDeleteByDataLakeTag).toHaveBeenCalledWith(lakeScope);
  });

  it('survives a member-id lookup that itself fails', async () => {
    const adapters = makeAdapters();
    adapters.db.fabFiles.findIdsByDataLakeTag = vi.fn().mockRejectedValue(new Error('mongo down'));
    await expect(
      deleteDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, retrievalIndex: indexPort() })
    ).resolves.toMatchObject({ status: 'deleted' });
    expect(adapters.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Best-effort index removal failed for datalake:lake'),
      expect.any(Error)
    );
  });
});

describe('cleanupDeletedDataLake — phase 2 sweep', () => {
  const makeAdapters = (status: IDataLakeDocument['status']) => ({
    db: {
      dataLakes: {
        findById: vi.fn().mockResolvedValue(lake({ status })),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      batches: { find: vi.fn().mockResolvedValue([{ id: 'b1' }]), delete: vi.fn().mockResolvedValue(undefined) },
      fabFiles: {
        findIdsByDataLakeTag: vi.fn().mockResolvedValue(['f1', 'f2']),
        hardDeleteByIds: vi.fn().mockResolvedValue(['f1', 'f2']),
      },
      fabFileChunks: { deleteManyByFabFileId: vi.fn().mockResolvedValue(undefined) },
    },
  });

  it('refuses to purge a lake that is not soft-deleted', async () => {
    const adapters = makeAdapters('active');
    await expect(cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters)).rejects.toThrow(
      /soft-deleted/i
    );
  });

  it('purges chunks, files, batches, then the lake when soft-deleted', async () => {
    const adapters = makeAdapters('deleted');
    await cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters);
    expect(adapters.db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledTimes(2);
    expect(adapters.db.fabFiles.hardDeleteByIds).toHaveBeenCalled();
    expect(adapters.db.batches.delete).toHaveBeenCalledWith('b1');
    expect(adapters.db.dataLakes.delete).toHaveBeenCalledWith('lake1');
  });

  it('is idempotent: already-gone lake is a no-op success', async () => {
    const adapters = makeAdapters('deleted');
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(null);
    await expect(
      cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', adapters)
    ).resolves.toBeUndefined();
    expect(adapters.db.dataLakes.delete).not.toHaveBeenCalled();
  });

  it('hands the index the whole membership scope and every member id, before it destroys any of them', async () => {
    const adapters = makeAdapters('deleted');
    adapters.db.fabFiles.findIdsByDataLakeTag = vi.fn().mockResolvedValue(memberIds);
    const retrievalIndex = indexPort();

    await cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, retrievalIndex });

    expect(removalInput(retrievalIndex)).toEqual({ scope: lakeScope, fabFileIds: memberIds });
    expect(removalInput(retrievalIndex).fabFileIds).toContain('prefix-only-file');

    const indexRemove = retrievalIndex.removeForDataLake.mock.invocationCallOrder[0];
    expect(indexRemove).toBeLessThan(
      Math.min(...adapters.db.fabFileChunks.deleteManyByFabFileId.mock.invocationCallOrder)
    );
    expect(indexRemove).toBeLessThan(adapters.db.fabFiles.hardDeleteByIds.mock.invocationCallOrder[0]);
  });

  it('purges exactly the ids it announced, so a mid-sweep joiner is not destroyed unaccounted for', async () => {
    const adapters = makeAdapters('deleted');
    adapters.db.fabFiles.findIdsByDataLakeTag = vi.fn().mockResolvedValue(memberIds);
    const retrievalIndex = indexPort();

    await cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, retrievalIndex });

    // By id, never by re-running the predicate: a file tagged into the lake after the resolve
    // would otherwise be hard-deleted with its chunks intact and the index never told.
    expect(adapters.db.fabFiles.hardDeleteByIds).toHaveBeenCalledWith(memberIds);
    expect(removalInput(retrievalIndex).fabFileIds).toEqual(memberIds);
    // Resolved once and reused. Re-resolving before the purge would pass the assertions above
    // while reopening the window they exist to close.
    expect(adapters.db.fabFiles.findIdsByDataLakeTag).toHaveBeenCalledTimes(1);
  });

  it('aborts the purge with nothing destroyed when the index removal fails', async () => {
    const adapters = makeAdapters('deleted');
    await expect(
      cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', {
        ...adapters,
        retrievalIndex: indexPort('fails'),
      })
    ).rejects.toThrow(/index unreachable/);

    // Unlike the reversible doors this one propagates, because an entry pointing at a purged file
    // can never be reconciled. The queue retry re-runs the whole sweep, so leaving it zero-progress
    // is what makes propagating safe.
    expect(adapters.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.hardDeleteByIds).not.toHaveBeenCalled();
    expect(adapters.db.batches.delete).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.delete).not.toHaveBeenCalled();
  });

  it('chunks the fan-outs yet processes every item and preserves step ordering', async () => {
    const adapters = makeAdapters('deleted');
    adapters.db.fabFiles.findIdsByDataLakeTag = vi.fn().mockResolvedValue(['f1', 'f2', 'f3']);
    adapters.db.batches.find = vi.fn().mockResolvedValue([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]);

    await cleanupDeletedDataLake({ userId: 'owner', isAdmin: false }, 'lake1', { ...adapters, chunkSize: 2 });

    // Every file's chunks and every batch are still deleted, despite the chunk size < count.
    expect(adapters.db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledTimes(3);
    expect(adapters.db.batches.delete).toHaveBeenCalledTimes(3);

    // Ordering contract: last chunk delete -> hard-delete files -> first batch delete -> lake last.
    const lastChunk = Math.max(...adapters.db.fabFileChunks.deleteManyByFabFileId.mock.invocationCallOrder);
    const hardDelete = adapters.db.fabFiles.hardDeleteByIds.mock.invocationCallOrder[0];
    const firstBatch = Math.min(...adapters.db.batches.delete.mock.invocationCallOrder);
    const lakeDelete = adapters.db.dataLakes.delete.mock.invocationCallOrder[0];
    expect(lastChunk).toBeLessThan(hardDelete);
    expect(hardDelete).toBeLessThan(firstBatch);
    expect(firstBatch).toBeLessThan(lakeDelete);
  });
});

describe('reconcileStuckBatches — guarded read-time reconciliation', () => {
  const batch = (overrides: Partial<IDataLakeBatchDocument> = {}): IDataLakeBatchDocument =>
    ({
      id: 'b1',
      dataLakeId: 'lake1',
      status: 'processing',
      updatedAt: new Date(0),
      ...overrides,
    }) as IDataLakeBatchDocument;

  const makeDb = () => ({
    dataLakes: { findById: vi.fn().mockResolvedValue(lake()), setStats: vi.fn() },
    batches: { markTerminalIfActive: vi.fn().mockResolvedValue(batch({ status: 'completed_with_errors' })) },
    fabFiles: { computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }) },
  });
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });

  it('forces a stuck non-terminal batch terminal (marked reconciler) and recomputes stats', async () => {
    const now = DEFAULT_STUCK_BATCH_TIMEOUT_MS + 10_000;
    const forced = await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db }, now);
    // The completionReason 'reconciler' is what distinguishes a forced terminal from normal completion.
    expect(db.batches.markTerminalIfActive).toHaveBeenCalledWith('b1', 'completed_with_errors', 'reconciler');
    expect(db.fabFiles.computeDataLakeStats).toHaveBeenCalled();
    expect(forced).toEqual(['b1']);
  });

  it('leaves a recently-updated batch alone', async () => {
    const recent = batch({ updatedAt: new Date(1000) });
    const now = 2000; // within timeout
    const forced = await reconcileStuckBatches([recent], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db }, now);
    expect(db.batches.markTerminalIfActive).not.toHaveBeenCalled();
    expect(forced).toEqual([]);
  });

  it('does NOT recompute when the guarded transition is lost (a real increment finalized first)', async () => {
    db.batches.markTerminalIfActive = vi.fn().mockResolvedValue(null); // lost the guard
    const now = DEFAULT_STUCK_BATCH_TIMEOUT_MS + 10_000;
    const forced = await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db }, now);
    expect(db.fabFiles.computeDataLakeStats).not.toHaveBeenCalled();
    expect(forced).toEqual([]);
  });

  const late = DEFAULT_STUCK_BATCH_TIMEOUT_MS + 10_000;

  it('emits the forced-terminal metric (passed the full post-transition batch) and the stuck gauge', async () => {
    const metrics = { emitForcedTerminal: vi.fn(), emitStuckGauge: vi.fn() };
    await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db, metrics }, late);
    // The full batch, not just its ids: app callers use this to also backstop the taxonomy
    // enqueue, which needs wantsTaxonomy/dataLakeId/userId off the doc.
    expect(metrics.emitForcedTerminal).toHaveBeenCalledWith(batch({ status: 'completed_with_errors' }));
    expect(metrics.emitStuckGauge).toHaveBeenCalledWith(1);
  });

  it('gauges the stuck count but does NOT emit forced-terminal when the guard is lost', async () => {
    db.batches.markTerminalIfActive = vi.fn().mockResolvedValue(null);
    const metrics = { emitForcedTerminal: vi.fn(), emitStuckGauge: vi.fn() };
    await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db, metrics }, late);
    expect(metrics.emitStuckGauge).toHaveBeenCalledWith(1);
    expect(metrics.emitForcedTerminal).not.toHaveBeenCalled();
  });

  it('gauges zero when nothing is stuck', async () => {
    const metrics = { emitForcedTerminal: vi.fn(), emitStuckGauge: vi.fn() };
    await reconcileStuckBatches(
      [batch({ updatedAt: new Date(1000) })],
      DEFAULT_STUCK_BATCH_TIMEOUT_MS,
      { db, metrics },
      2000
    );
    expect(metrics.emitStuckGauge).toHaveBeenCalledWith(0);
    expect(metrics.emitForcedTerminal).not.toHaveBeenCalled();
  });

  it('still reconciles when a metric hook throws (metrics must never break reconcile)', async () => {
    const metrics = {
      emitForcedTerminal: vi.fn(() => {
        throw new Error('cloudwatch down');
      }),
      emitStuckGauge: vi.fn(() => {
        throw new Error('cloudwatch down');
      }),
    };
    const forced = await reconcileStuckBatches([batch()], DEFAULT_STUCK_BATCH_TIMEOUT_MS, { db, metrics }, late);
    expect(forced).toEqual(['b1']);
    expect(db.fabFiles.computeDataLakeStats).toHaveBeenCalled();
  });
});

describe('removeFileFromDataLake — single-file removal', () => {
  // A wizard-ingested file as it really looks: the lake meta-tag AND a folder tag under the
  // lake's fileTagPrefix (both are membership signals the read path ORs). Also in a second
  // lake, and carrying that lake's prefixed tag, to prove removal is lake-scoped.
  const fileInLake = {
    id: 'f1',
    userId: 'owner',
    tags: [
      { name: 'datalake:lake', strength: 1 },
      { name: 'lk:invoices', strength: 1 },
      { name: 'datalake:other', strength: 1 },
      { name: 'other:keepme', strength: 1 },
    ],
  };

  const makeAdapters = (file: unknown = fileInLake) => ({
    db: {
      dataLakes: { findById: vi.fn().mockResolvedValue(lake()), setStats: vi.fn() },
      fabFiles: {
        findById: vi.fn().mockResolvedValue(file),
        pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }),
      },
    },
  });

  it('clears BOTH membership signals for this lake, keeps other lakes, and recomputes stats (owner)', async () => {
    const adapters = makeAdapters();
    const result = await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    // The read path admits a file on the meta-tag OR the lake's fileTagPrefix, so both go in
    // ONE atomic $pull - never a whole-array rewrite (which could clobber a concurrent
    // removal) and never a soft-delete. The other lake's tags are untouched.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
    expect(adapters.db.dataLakes.setStats).toHaveBeenCalled();
    expect(result).toEqual({ success: true, fileCount: 0, totalSizeBytes: 0 });
  });

  it('removes a file whose only membership signal is a prefixed tag', async () => {
    // These exist in quantity (see getDynamicDataLakeAccess): the lake browse lists them, so
    // testing membership on the meta-tag alone made them permanently unremovable.
    const prefixOnly = { id: 'f1', userId: 'owner', tags: [{ name: 'lk:invoices', strength: 1 }] };
    const adapters = makeAdapters(prefixOnly);
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).resolves.toMatchObject({ success: true });
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
  });

  it('refuses to strip a prefixed tag off a file the actor does not own', async () => {
    // fileTagPrefix is user-chosen and neither unique nor reserved, so a prefix match alone is
    // not proof of membership. Without the ownership conjunct, minting a lake with someone
    // else's prefix would be a licence to strip their tags.
    const someoneElses = { id: 'f1', userId: 'victim', tags: [{ name: 'lk:invoices', strength: 1 }] };
    const adapters = makeAdapters(someoneElses);
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('treats a file with no owner as unowned rather than matching the prefix arm', async () => {
    const ownerless = { id: 'f1', tags: [{ name: 'lk:invoices', strength: 1 }] };
    const adapters = makeAdapters(ownerless);
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses even an admin removing a prefix-only file the lake creator does not own', async () => {
    // The prefix arm is anchored to the LAKE'S CREATOR, matching the read path's own membership
    // predicate - an admin bypass here would let an admin strip a tag off a file the read path
    // never actually admitted to this lake.
    const someoneElses = { id: 'f1', userId: 'victim', tags: [{ name: 'lk:invoices', strength: 1 }] };
    const adapters = makeAdapters(someoneElses);
    await expect(
      removeFileFromDataLake({ userId: 'root', isAdmin: true }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('lets an admin remove a prefix-only file the lake creator DOES own', async () => {
    const creatorsFile = { id: 'f1', userId: 'owner', tags: [{ name: 'lk:invoices', strength: 1 }] };
    const adapters = makeAdapters(creatorsFile);
    await expect(
      removeFileFromDataLake({ userId: 'root', isAdmin: true }, 'lake1', 'f1', adapters as any)
    ).resolves.toMatchObject({ success: true });
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
  });

  it('ignores a fileTagPrefix no read arm would match, rather than clearing every tag', async () => {
    // An empty prefix contributes no read arm, so there is nothing for removal to clear. It
    // must not become a wildcard that empties the file's tags.
    const adapters = makeAdapters({ id: 'f1', userId: 'owner', tags: [{ name: 'anything', strength: 1 }] });
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(lake({ fileTagPrefix: '' }));
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  // The next two pin removal to the SAME normalization the read arms apply, so the prefixes a
  // query matches are exactly the ones a removal clears - neither more nor fewer.
  it('ignores a prefix missing its trailing colon, which no read arm honors either', async () => {
    const adapters = makeAdapters();
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(lake({ fileTagPrefix: 'lk' }));
    await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    // `lk` would match `lk:invoices` on a bare startsWith, but the read path drops the prefix
    // outright, so clearing that tag would be removing a tag membership never depended on.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
  });

  it('clears prefixed tags for a padded prefix, matching the trim the read arms do', async () => {
    const adapters = makeAdapters();
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(lake({ fileTagPrefix: '  lk:  ' }));
    await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
  });

  it('never strips another lake meta-tag, even when this lake claims the reserved prefix', async () => {
    const adapters = makeAdapters();
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(lake({ fileTagPrefix: 'datalake:' }));
    await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    // Only this lake's own tag: `datalake:other` belongs to a lake the actor may not manage.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
  });

  it('reports success when the pull modified nothing (a concurrent removal won the race)', async () => {
    const adapters = makeAdapters();
    adapters.db.fabFiles.pullTagsByFabFileId = vi.fn().mockResolvedValue(0);
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).resolves.toMatchObject({ success: true });
  });

  it('removing the file from its ONLY lake still just pulls the tag — never cascade-deletes the file', async () => {
    // Guards the invariant that a file's existence is independent of any lake: even when this
    // is the last lake it belongs to, removal drops the tag and leaves the FabFile intact.
    const fileInOnlyThisLake = { id: 'f1', tags: [{ name: 'datalake:lake', strength: 1 }] };
    const adapters = makeAdapters(fileInOnlyThisLake);
    const result = await removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any);
    // Same tag-pull path as the multi-lake case - the service has no cascade-delete branch,
    // so "last lake" is not special: the tag is pulled and the file is left to exist.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
    expect(result).toEqual({ success: true, fileCount: 0, totalSizeBytes: 0 });
  });

  it('allows an admin who is not the creator', async () => {
    const adapters = makeAdapters();
    await expect(
      removeFileFromDataLake({ userId: 'other', isAdmin: true }, 'lake1', 'f1', adapters as any)
    ).resolves.toMatchObject({ success: true });
  });

  it('rejects a non-creator non-admin (no teardown)', async () => {
    const adapters = makeAdapters();
    await expect(
      removeFileFromDataLake({ userId: 'intruder', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/creator/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    // The gate runs before any write, so a denial leaves the lake's stats alone too.
    expect(adapters.db.dataLakes.setStats).not.toHaveBeenCalled();
  });

  it('404s when the file does not carry the lake tag (not in this lake)', async () => {
    const adapters = makeAdapters({ id: 'f1', tags: [{ name: 'datalake:other', strength: 1 }] });
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('404s when the lake does not exist', async () => {
    const adapters = makeAdapters();
    adapters.db.dataLakes.findById = vi.fn().mockResolvedValue(null);
    await expect(
      removeFileFromDataLake({ userId: 'owner', isAdmin: false }, 'lake1', 'f1', adapters as any)
    ).rejects.toThrow(/Data lake not found/i);
  });
});

describe('setLakeVisibility — personal ↔ org promotion', () => {
  const makeDb = (existing: Partial<IDataLakeDocument> = {}, clashes: IDataLakeDocument[] = []) => ({
    dataLakes: {
      findById: vi.fn().mockResolvedValue(lake(existing)),
      find: vi.fn().mockResolvedValue(clashes),
      update: vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => lake(d)),
    },
  });

  it('promotes a personal lake to the actor’s org (org from principal, not the body)', async () => {
    const db = makeDb(); // existing lake is org-less (private)
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    expect(db.dataLakes.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake1', organizationId: 'orgA' }));
  });

  /** The move runs the slug query first, then the prefix query; answer them separately. */
  const makeMoveDb = (prefixClashes: IDataLakeDocument[]) => ({
    dataLakes: {
      findById: vi.fn().mockResolvedValue(lake()),
      find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(prefixClashes),
      update: vi.fn().mockImplementation(async (d: Partial<IDataLakeDocument>) => lake(d)),
    },
  });

  it('refuses an org move whose tag prefix overlaps a lake already in the target scope', async () => {
    // Create-time is not enough: this is the other way two lakes end up sharing a prefix, and then
    // permanently deleting one takes files only the other holds.
    const db = makeMoveDb([lake({ id: 'other', name: 'Sibling', fileTagPrefix: 'lk:' })]);
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/overlaps an existing data lake/i);
    expect(db.dataLakes.update).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'orgA' }));
  });

  it('allows an org move when nothing in the target scope shares the prefix', async () => {
    const db = makeMoveDb([lake({ id: 'other', fileTagPrefix: 'other-prefix:' })]);
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    expect(db.dataLakes.update).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'orgA' }));
  });

  it('demotes an org lake back to private by clearing organizationId (null, not undefined)', async () => {
    const db = makeDb({ organizationId: 'orgA' });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'private', {
      db,
    } as any);
    expect(db.dataLakes.update.mock.calls[0][0].organizationId).toBeNull();
  });

  it('rejects a non-creator non-admin', async () => {
    const db = makeDb();
    await expect(
      setLakeVisibility({ userId: 'intruder', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/creator/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('rejects promotion when the actor has no organization', async () => {
    const db = makeDb();
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: undefined }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/organization/i);
  });

  it('rejects when the target scope already has a lake with that slug (collision guard)', async () => {
    const db = makeDb({}, [lake({ id: 'other', slug: 'lake', organizationId: 'orgA' })]);
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/already exists/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('is a no-op when already in the requested visibility (no update)', async () => {
    const db = makeDb({ organizationId: 'orgA' });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('blocks a non-owner admin from PROMOTING (no cross-org steal into the admin’s org)', async () => {
    const db = makeDb(); // lake owned by 'owner'
    await expect(
      setLakeVisibility({ userId: 'admin', isAdmin: true, organizationId: 'orgZ' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/owner/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('lets a non-owner admin DEMOTE a lake to private (removes scope, writes null — no steal)', async () => {
    const db = makeDb({ organizationId: 'orgA' });
    await setLakeVisibility({ userId: 'admin', isAdmin: true, organizationId: 'orgZ' }, 'lake1', 'private', {
      db,
    } as any);
    expect(db.dataLakes.update.mock.calls[0][0].organizationId).toBeNull();
  });

  it('maps a TOCTOU duplicate-key (E11000) on write to the friendly collision error', async () => {
    const db = makeDb(); // find pre-check passes, but the write loses the race
    db.dataLakes.update = vi.fn().mockRejectedValue(Object.assign(new Error('E11000 dup key'), { code: 11000 }));
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
        db,
      } as any)
    ).rejects.toThrow(/already exists/i);
  });

  it('publishes a private lake: sets isPublic=true and clears org (no slug-collision round-trip)', async () => {
    const db = makeDb(); // existing lake is org-less, not public
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: undefined }, 'lake1', 'public', {
      db,
    } as any);
    // private -> public keeps the same (org-less) slug scope, so no collision query is needed.
    expect(db.dataLakes.find).not.toHaveBeenCalled();
    const written = db.dataLakes.update.mock.calls[0][0];
    expect(written.isPublic).toBe(true);
    expect(written.organizationId).toBeNull();
  });

  it('un-publishes: public -> private writes isPublic=false', async () => {
    const db = makeDb({ isPublic: true });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: undefined }, 'lake1', 'private', {
      db,
    } as any);
    const written = db.dataLakes.update.mock.calls[0][0];
    expect(written.isPublic).toBe(false);
    expect(written.organizationId).toBeNull();
  });

  it('promoting to org clears any prior public flag (mutually exclusive tri-state)', async () => {
    const db = makeDb({ isPublic: true });
    await setLakeVisibility({ userId: 'owner', isAdmin: false, organizationId: 'orgA' }, 'lake1', 'organization', {
      db,
    } as any);
    const written = db.dataLakes.update.mock.calls[0][0];
    expect(written).toMatchObject({ organizationId: 'orgA', isPublic: false });
  });

  it('refuses to publish a lake gated by a required tag (PHI/access-gate guardrail)', async () => {
    const db = makeDb({ requiredUserTag: 'Opti' });
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false }, 'lake1', 'public', { db } as any)
    ).rejects.toThrow(/can’t be made public/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('refuses to publish a lake gated by a required entitlement', async () => {
    const db = makeDb({ requiredEntitlement: 'product:pro' });
    await expect(
      setLakeVisibility({ userId: 'owner', isAdmin: false }, 'lake1', 'public', { db } as any)
    ).rejects.toThrow(/can’t be made public/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('blocks a non-owner admin from PUBLISHING (no exposing someone else’s lake app-wide)', async () => {
    const db = makeDb(); // lake owned by 'owner'
    await expect(
      setLakeVisibility({ userId: 'admin', isAdmin: true, organizationId: 'orgZ' }, 'lake1', 'public', { db } as any)
    ).rejects.toThrow(/owner/i);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });

  it('is a no-op when already public (no update)', async () => {
    const db = makeDb({ isPublic: true });
    await setLakeVisibility({ userId: 'owner', isAdmin: false }, 'lake1', 'public', { db } as any);
    expect(db.dataLakes.update).not.toHaveBeenCalled();
  });
});

describe('browsePublicDataLakes — public discover catalog projection', () => {
  const publicLake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
    lake({
      id: 'pub1',
      slug: 'pub1',
      name: 'Public One',
      description: 'a shared lake',
      createdByUserId: 'owner1',
      isPublic: true,
      fileCount: 3,
      totalSizeBytes: 2048,
      ...overrides,
    });

  const makeDb = (lakes: IDataLakeDocument[], total = lakes.length) => ({
    dataLakes: { findPublicLakes: vi.fn().mockResolvedValue({ lakes, total }) },
    users: {
      findByIds: vi.fn().mockResolvedValue([
        { id: 'owner1', name: 'Ada Owner', username: 'ada', email: 'ada@example.com' },
        { id: 'owner2', username: 'onlyuser', email: 'nn@example.com' },
      ]),
    },
  });

  it('maps a lake to its card summary with owner name, counts, and per-caller flags', async () => {
    const db = makeDb([publicLake()]);
    const { data, total } = await browsePublicDataLakes({ userId: 'someone-else', isAdmin: false }, {}, { db } as any);
    expect(total).toBe(1);
    expect(data[0]).toMatchObject({
      id: 'pub1',
      name: 'Public One',
      description: 'a shared lake',
      ownerDisplayName: 'Ada Owner',
      fileCount: 3,
      totalSizeBytes: 2048,
      isOwn: false,
      canManage: false,
    });
  });

  it('never exposes the owner email; falls back to username when name is absent', async () => {
    const db = makeDb([publicLake({ id: 'pub2', slug: 'pub2', createdByUserId: 'owner2' })]);
    const { data } = await browsePublicDataLakes({ userId: 'x', isAdmin: false }, {}, { db } as any);
    expect(data[0].ownerDisplayName).toBe('onlyuser');
    // No summary field should ever carry an email address.
    expect(JSON.stringify(data)).not.toContain('@example.com');
  });

  it('marks the caller’s own lake and grants manage to owner and admin', async () => {
    const db = makeDb([publicLake({ createdByUserId: 'owner1' })]);
    const asOwner = await browsePublicDataLakes({ userId: 'owner1', isAdmin: false }, {}, { db } as any);
    expect(asOwner.data[0]).toMatchObject({ isOwn: true, canManage: true });

    const asAdmin = await browsePublicDataLakes({ userId: 'someone', isAdmin: true }, {}, { db } as any);
    expect(asAdmin.data[0]).toMatchObject({ isOwn: false, canManage: true });
  });

  it('defaults missing counts to 0 and skips the owner lookup when there are no lakes', async () => {
    const empty = makeDb([], 0);
    const { data, total } = await browsePublicDataLakes({ userId: 'x', isAdmin: false }, {}, { db: empty } as any);
    expect(data).toEqual([]);
    expect(total).toBe(0);
    expect(empty.users.findByIds).not.toHaveBeenCalled();

    const noStats = makeDb([publicLake({ fileCount: undefined, totalSizeBytes: undefined })]);
    const res = await browsePublicDataLakes({ userId: 'x', isAdmin: false }, {}, { db: noStats } as any);
    expect(res.data[0]).toMatchObject({ fileCount: 0, totalSizeBytes: 0 });
  });

  it('threads search + paging through to the repository', async () => {
    const db = makeDb([publicLake()]);
    await browsePublicDataLakes({ userId: 'x', isAdmin: false }, { search: 'widgets', limit: 10, offset: 20 }, {
      db,
    } as any);
    expect(db.dataLakes.findPublicLakes).toHaveBeenCalledWith({ search: 'widgets', limit: 10, offset: 20 });
  });
});
