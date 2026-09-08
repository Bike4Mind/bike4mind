import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { MAX_DATA_LAKE_SLUG_LENGTH, MIN_DATA_LAKE_SLUG_LENGTH, DATA_LAKE_SLUG_REGEX } from '@bike4mind/common';
import { buildDatalakeTag, createDataLake, isDatalakeTagWellFormed } from './createDataLake';

describe('isDatalakeTagWellFormed (trap 4: org-qualified vs plain datalake tag)', () => {
  it('accepts the org-qualified form for an org lake', () => {
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:org1:sales', slug: 'sales', organizationId: 'org1' })).toBe(
      true
    );
  });

  it('accepts the PLAIN form for an org lake (promoted org-less -> org keeps its original tag)', () => {
    // setLakeVisibility deliberately does not re-mint the tag on promotion, so an org lake can still
    // carry datalake:<slug>. Without tolerance it would silently drop off the owner-exemption path.
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:sales', slug: 'sales', organizationId: 'org1' })).toBe(
      true
    );
  });

  it('accepts the plain form for an org-less lake', () => {
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:sales', slug: 'sales', organizationId: undefined })).toBe(
      true
    );
  });

  it('rejects a tag that is neither the org-qualified nor the plain form of its slug', () => {
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:other', slug: 'sales', organizationId: 'org1' })).toBe(
      false
    );
    // A different org qualifier is not well-formed either (globally-unique tag, so this is a mismatch).
    expect(isDatalakeTagWellFormed({ datalakeTag: 'datalake:org2:sales', slug: 'sales', organizationId: 'org1' })).toBe(
      false
    );
  });

  it('agrees with buildDatalakeTag for both scopes', () => {
    expect(buildDatalakeTag('sales', 'org1')).toBe('datalake:org1:sales');
    expect(buildDatalakeTag('sales')).toBe('datalake:sales');
  });
});

describe('createDataLake seeds an owner access grant', () => {
  const makeDb = () => {
    const created = { id: 'newLakeId', createdByUserId: 'creator' } as IDataLakeDocument;
    const upsertGrant = vi.fn(async () => ({}) as never);
    return {
      upsertGrant,
      db: {
        dataLakes: {
          find: vi.fn(async () => []), // no slug / prefix collisions
          create: vi.fn(async () => created),
        },
        dataLakeAccessGrants: { upsertGrant },
      },
    };
  };

  const params = { name: 'Sales', slug: 'sales', fileTagPrefix: 'sl:' } as Parameters<typeof createDataLake>[1];

  it('seeds an owner grant for the creator on the new lake', async () => {
    const { db, upsertGrant } = makeDb();
    await createDataLake('creator', params, { db } as never);
    expect(upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'newLakeId',
        principalType: 'user',
        principalId: 'creator',
        role: 'owner',
        grantedByUserId: 'creator',
      })
    );
  });

  it('still returns the created lake when the grant seed fails (best-effort, logged)', async () => {
    const { db } = makeDb();
    db.dataLakeAccessGrants.upsertGrant = vi.fn(async () => {
      throw new Error('grant write failed');
    });
    const logger = { warn: vi.fn() };
    const lake = await createDataLake('creator', params, { db, logger } as never);
    expect(lake).toEqual(expect.objectContaining({ id: 'newLakeId' }));
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createDataLake slug disambiguation stays inside MAX_DATA_LAKE_SLUG_LENGTH (#2032)', () => {
  /**
   * `find` reports a collision for every slug in `taken`, so disambiguation is forced to keep
   * incrementing. The created document is echoed back so the test can read the slug that was
   * actually persisted - which is the thing the bug was about, not the value validated on the way in.
   */
  const makeDb = (taken: string[]) => {
    const create = vi.fn(async (doc: Record<string, unknown>) => ({ id: 'newLakeId', ...doc }) as never);
    return {
      create,
      db: {
        dataLakes: {
          find: vi.fn(async (filter: { slug?: string }) => (taken.includes(filter.slug ?? '') ? [{ id: 'x' }] : [])),
          create,
        },
        dataLakeAccessGrants: { upsertGrant: vi.fn(async () => ({}) as never) },
      },
    };
  };

  const paramsFor = (slug: string) =>
    ({ name: slug, slug, fileTagPrefix: 'sl:' }) as Parameters<typeof createDataLake>[1];

  it('truncates the base so a maximum-length slug plus its suffix still fits', async () => {
    // A 60-char slug is legal on the way in; appending "-1" used to persist 62 - a slug every other
    // surface judges illegal, including the datalake:<slug> entitlement key.
    const base = 'a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH);
    const { db, create } = makeDb([base]);

    await createDataLake('creator', paramsFor(base), { db } as never);

    const slug = create.mock.calls[0][0].slug as string;
    // These two assertions are not independent sanity checks - together they ARE the predicate
    // registry.ts applies to a `datalake:<slug>` entitlement key (`slug.length <= MAX && REGEX`).
    // Dropping either one stops testing the bug this PR exists for.
    expect(slug.length).toBeLessThanOrEqual(MAX_DATA_LAKE_SLUG_LENGTH);
    expect(slug).toMatch(DATA_LAKE_SLUG_REGEX);
    expect(slug).toBe(`${'a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 2)}-1`);
  });

  it('keeps fitting once the suffix reaches two digits', async () => {
    // The suffix grows, so the room for the base has to shrink with it.
    const base = 'a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH);
    // Suffixes start at 1: attempt 0 returns the base unsuffixed, so `-0` is never a candidate.
    const taken = [
      base,
      ...Array.from({ length: 9 }, (_, i) => `${'a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 2)}-${i + 1}`),
    ];
    const { db, create } = makeDb(taken);

    await createDataLake('creator', paramsFor(base), { db } as never);

    const slug = create.mock.calls[0][0].slug as string;
    expect(slug).toBe(`${'a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 3)}-10`);
    expect(slug.length).toBe(MAX_DATA_LAKE_SLUG_LENGTH);
    expect(slug).toMatch(DATA_LAKE_SLUG_REGEX);
  });

  it('does not leave a doubled hyphen when the cut lands mid-hyphen', async () => {
    // `...a--1` matches the regex (interior runs are allowed) but reads as a typo, so the trim
    // strips it. The base is regex-guaranteed to start alphanumeric, so this can never empty it.
    const base = `a${'-'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 2)}b`;
    const { db, create } = makeDb([base]);

    await createDataLake('creator', paramsFor(base), { db } as never);

    const slug = create.mock.calls[0][0].slug as string;
    expect(slug).not.toContain('--');
    expect(slug).toBe('a-1');
    // The only case where the trim eats the base down to one character, so it is where the
    // "cannot fall under the minimum" argument actually bites. Pin the floor, not just the literal.
    expect(slug.length).toBeGreaterThanOrEqual(MIN_DATA_LAKE_SLUG_LENGTH);
    expect(slug).toMatch(DATA_LAKE_SLUG_REGEX);
  });

  it('leaves a short slug untouched, so the bound only bites where it has to', async () => {
    const { db, create } = makeDb(['sales']);

    await createDataLake('creator', paramsFor('sales'), { db } as never);

    expect(create.mock.calls[0][0].slug).toBe('sales-1');
  });

  it('uses the base itself when nothing collides', async () => {
    const base = 'a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH);
    const { db, create } = makeDb([]);

    await createDataLake('creator', paramsFor(base), { db } as never);

    expect(create.mock.calls[0][0].slug).toBe(base);
  });
});
