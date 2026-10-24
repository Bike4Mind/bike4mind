import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { PUBLISH_QUOTAS } from '@bike4mind/common';
import { PublishedArtifact } from '@bike4mind/database';
import { checkInPlaceRewriteQuota, checkPublishQuota } from './checkPublishQuota';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Against a real database, so the aggregation pipeline itself is under test: a mocked aggregate
// cannot show that page count is no longer enforced, that an owner with no rows reads as zero
// usage, or that soft-deleted and overwritten rows stay out of the byte sum.

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const OWNER = 'owner-1';
const ORG = 'org-1';
const USER_CAP = PUBLISH_QUOTAS.user.maxTotalBytes;
const ORG_CAP = PUBLISH_QUOTAS.org.maxTotalBytes;

interface PageOverrides {
  ownerId?: string;
  tier?: 'user' | 'organization';
  scopeId?: string;
  slug?: string;
  bytes?: number;
  deletedAt?: Date | null;
}

let seq = 0;
const page = (over: PageOverrides = {}) => {
  seq += 1;
  const ownerId = over.ownerId ?? OWNER;
  return {
    publicId: `pub-${seq}`,
    tier: over.tier ?? 'user',
    scopeId: over.scopeId ?? ownerId,
    slug: over.slug ?? `page-${seq}`,
    title: 'Page',
    ownerId,
    visibility: 'public',
    source: { kind: 'bundle' },
    storageKeyPrefix: '',
    manifest: [],
    size: { totalBytes: over.bytes ?? 1024, fileCount: 1 },
    deletedAt: over.deletedAt ?? null,
  };
};

const seed = (pages: ReturnType<typeof page>[]) => PublishedArtifact.insertMany(pages);

describe('checkPublishQuota (real database)', () => {
  it('lets a user who already hosts more pages than the old 100-page cap publish another', async () => {
    await seed(Array.from({ length: 150 }, () => page()));

    const result = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: 1024, fileCount: 1 } });

    expect(result).toEqual({ ok: true });
  });

  it('lets an org that hosts more pages than the old 1,000-page cap take another', async () => {
    await seed(
      Array.from({ length: 1050 }, (_, i) => page({ ownerId: `member-${i % 20}`, tier: 'organization', scopeId: ORG }))
    );

    const result = await checkPublishQuota({
      ownerId: 'member-0',
      orgScopeId: ORG,
      incoming: { bytes: 1024, fileCount: 1 },
    });

    expect(result).toEqual({ ok: true });
  });

  it('allows a publish that lands exactly on the user byte cap and refuses one byte more', async () => {
    await seed([page({ bytes: USER_CAP / 2 }), page({ bytes: USER_CAP / 2 - 1024 })]);

    const exact = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: 1024, fileCount: 1 } });
    expect(exact).toEqual({ ok: true });

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: 1025, fileCount: 1 } });
    if (over.ok) throw new Error('expected the user byte cap to refuse the publish');
    expect(over.status).toBe(413);
    expect(over.code).toBe('quota_bytes_exceeded');
    expect(over.details).toEqual({ scope: 'user', limit: USER_CAP, current: USER_CAP - 1024, attempted: USER_CAP + 1 });
  });

  it('refuses a publish into an org that is full even when the publishing user has room', async () => {
    // Other members fill the org, so only the org ladder can refuse.
    await seed([
      page({ ownerId: 'member-1', tier: 'organization', scopeId: ORG, bytes: ORG_CAP / 2 }),
      page({ ownerId: 'member-2', tier: 'organization', scopeId: ORG, bytes: ORG_CAP / 2 }),
    ]);

    const result = await checkPublishQuota({ ownerId: OWNER, orgScopeId: ORG, incoming: { bytes: 1, fileCount: 1 } });

    if (result.ok) throw new Error('expected the org byte cap to refuse the publish');
    expect(result.status).toBe(413);
    expect(result.code).toBe('quota_bytes_exceeded');
    expect(result.details).toEqual({ scope: 'org', limit: ORG_CAP, current: ORG_CAP, attempted: ORG_CAP + 1 });
  });

  it('reads an owner with no rows as zero usage', async () => {
    const fits = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP, fileCount: 1 } });
    expect(fits).toEqual({ ok: true });

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP + 1, fileCount: 1 } });
    if (over.ok) throw new Error('expected the user byte cap to refuse the publish');
    expect(over.details.current).toBe(0);
  });

  it('leaves soft-deleted rows and the row being overwritten out of the byte sum', async () => {
    await seed([page({ bytes: USER_CAP, deletedAt: new Date() }), page({ slug: 'mine', bytes: USER_CAP })]);
    const incoming = { bytes: USER_CAP, fileCount: 1 };

    const overwrite = await checkPublishQuota({
      ownerId: OWNER,
      incoming,
      replacing: { tier: 'user', scopeId: OWNER, slug: 'mine' },
    });
    expect(overwrite).toEqual({ ok: true });

    const fresh = await checkPublishQuota({ ownerId: OWNER, incoming });
    if (fresh.ok) throw new Error('expected the live row to count toward the user byte cap');
    expect(fresh.details.current).toBe(USER_CAP);
  });
});

// revise.ts and restore.ts rewrite a live page's index.html in place. Only the net change counts.
describe('checkInPlaceRewriteQuota (real database)', () => {
  const SLUG = 'rewritten';
  const PAGE_BYTES = 10_000;
  const rewritten = (over: { tier?: 'user' | 'organization'; scopeId?: string } = {}) => ({
    ownerId: OWNER,
    tier: over.tier ?? ('user' as const),
    scopeId: over.scopeId ?? OWNER,
    slug: SLUG,
    size: { totalBytes: PAGE_BYTES },
  });

  it('allows growth that lands exactly on the cap and refuses one byte more, counting only the delta', async () => {
    // The rest of the owner's pages leave exactly 500 bytes of room for this page to grow into.
    const room = 500;
    await seed([page({ slug: SLUG, bytes: PAGE_BYTES }), page({ bytes: USER_CAP - PAGE_BYTES - room })]);

    const exact = await checkInPlaceRewriteQuota({
      artifact: rewritten(),
      next: { bytes: PAGE_BYTES + room, fileCount: 1 },
    });
    expect(exact).toEqual({ ok: true });

    const over = await checkInPlaceRewriteQuota({
      artifact: rewritten(),
      next: { bytes: PAGE_BYTES + room + 1, fileCount: 1 },
    });
    if (over.ok) throw new Error('expected growth past the cap to be refused');
    expect(over.status).toBe(413);
    expect(over.code).toBe('quota_bytes_exceeded');
    // `current` is usage without this page; `attempted` is that plus the page's new total.
    expect(over.details).toEqual({
      scope: 'user',
      limit: USER_CAP,
      current: USER_CAP - PAGE_BYTES - room,
      attempted: USER_CAP + 1,
    });
  });

  it('allows a rewrite that does not grow the page, even for an owner already over the cap', async () => {
    await seed([page({ slug: SLUG, bytes: PAGE_BYTES }), page({ bytes: USER_CAP })]);

    expect(
      await checkInPlaceRewriteQuota({ artifact: rewritten(), next: { bytes: PAGE_BYTES, fileCount: 1 } })
    ).toEqual({ ok: true });
    expect(
      await checkInPlaceRewriteQuota({ artifact: rewritten(), next: { bytes: PAGE_BYTES - 1, fileCount: 1 } })
    ).toEqual({ ok: true });

    const grows = await checkInPlaceRewriteQuota({
      artifact: rewritten(),
      next: { bytes: PAGE_BYTES + 1, fileCount: 1 },
    });
    expect(grows.ok).toBe(false);
  });

  it('checks the org ladder for a page in an org scope', async () => {
    await seed([
      page({ tier: 'organization', scopeId: ORG, slug: SLUG, bytes: PAGE_BYTES }),
      page({ ownerId: 'member-2', tier: 'organization', scopeId: ORG, bytes: ORG_CAP - PAGE_BYTES }),
    ]);

    const result = await checkInPlaceRewriteQuota({
      artifact: rewritten({ tier: 'organization', scopeId: ORG }),
      next: { bytes: PAGE_BYTES + 1, fileCount: 1 },
    });

    if (result.ok) throw new Error('expected the full org to refuse the growth');
    expect(result.details.scope).toBe('org');
  });

  it('lets an admin grow a page past the cap', async () => {
    await seed([page({ slug: SLUG, bytes: PAGE_BYTES }), page({ bytes: USER_CAP })]);

    const result = await checkInPlaceRewriteQuota({
      isAdmin: true,
      artifact: rewritten(),
      next: { bytes: PAGE_BYTES * 2, fileCount: 1 },
    });

    expect(result).toEqual({ ok: true });
  });
});
