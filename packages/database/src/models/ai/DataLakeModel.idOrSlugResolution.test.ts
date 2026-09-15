import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * Pins the behavior every "resolve a lake by id OR slug" call site depends on.
 *
 * `findById` is a bare `model.findById(id)` (BaseModel), so Mongoose REJECTS with a CastError on a
 * non-ObjectId string rather than resolving null. A caller that writes the natural-looking
 * `findById(x) ?? findBySlug(x)` therefore never reaches the slug fallback - the rejection escapes
 * first and the caller 404s for every by-slug request. That defect shipped in the proposal seed
 * route and was caught only against a live preview, because a unit test mocking `findById` to
 * RESOLVE null cannot reproduce it.
 *
 * These tests exist so the assumption is checked against a real Mongo, not a mock. If `findById`
 * ever starts returning null for a malformed id, the first test fails loudly and every
 * `.catch(() => null)` in the id-or-slug call sites becomes removable dead code - which is exactly
 * the signal a future reader needs.
 */

const baseLake = (overrides: Partial<IDataLake> & Pick<IDataLake, 'slug'>): Omit<IDataLake, 'id'> =>
  ({
    name: overrides.slug,
    fileTagPrefix: `${overrides.slug}:`,
    datalakeTag: `datalake:${overrides.slug}`,
    createdByUserId: 'owner-1',
    status: 'active',
    ...overrides,
  }) as Omit<IDataLake, 'id'>;

describe('DataLakeRepository id-or-slug resolution', () => {
  setupMongoTest();

  it('findById REJECTS on a non-ObjectId rather than resolving null', async () => {
    await expect(dataLakeRepository.findById('proposal-qa')).rejects.toThrow();
  });

  it('findById resolves UNDEFINED (not null) for a well-formed id that matches nothing', async () => {
    // The contrast that makes the rejection above a CAST failure, not a not-found - and a second
    // trap in its own right. BaseModel returns `result?.toJSON() as T | null`, so a miss yields
    // `undefined` even though the declared type says `| null`. A call site testing `=== null`
    // would therefore treat a miss as a HIT; `??` (which this file's pattern uses) handles both.
    const missed = await dataLakeRepository.findById('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(missed).toBeUndefined();
    expect(missed ?? null).toBeNull();
  });

  it('findBySlug resolves an org-less lake by its slug', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'proposal-qa' }));

    const found = await dataLakeRepository.findBySlug('proposal-qa');

    expect(found?.id).toBe(created.id);
  });

  it('the guarded id-or-slug pattern resolves a lake by slug', async () => {
    // The exact expression the seed route (and assertLakeAccess.ts:146) uses. Without the
    // `.catch(() => null)` this line throws instead of returning the lake.
    const created = await dataLakeRepository.create(baseLake({ slug: 'proposal-qa' }));

    const resolved =
      (await dataLakeRepository.findById('proposal-qa').catch(() => null)) ??
      (await dataLakeRepository.findBySlug('proposal-qa'));

    expect(resolved?.id).toBe(created.id);
  });

  it('the guarded pattern still resolves by id, and never queries by slug for one', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'proposal-qa' }));

    const resolved =
      (await dataLakeRepository.findById(created.id).catch(() => null)) ??
      (await dataLakeRepository.findBySlug(created.id));

    expect(resolved?.id).toBe(created.id);
  });
});
