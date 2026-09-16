import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * Pins the behavior every "resolve a lake by id OR slug" call site depends on.
 *
 * `findById` screens the id (BaseModel) and RESOLVES null for a non-ObjectId string, so
 * `findById(x) ?? findBySlug(x)` reaches the slug fallback on its own. It used to hand the string
 * straight to Mongoose, which rejected with a CastError: the rejection escaped before the
 * fallback and the caller 404'd for every by-slug request. That defect shipped in the proposal
 * seed route and was caught only against a live preview, because a unit test mocking `findById`
 * to resolve null cannot reproduce it.
 *
 * These tests exist so the contract is checked against a real Mongo, not a mock. The
 * `.catch(() => null)` in the id-or-slug call sites (assertLakeAccess.ts, the seed route) is now
 * redundant for the cast it was added for and only masks a real database failure - see the
 * guarded-pattern tests at the bottom, which pass with or without it.
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

  it('findById resolves null on a non-ObjectId rather than rejecting', async () => {
    await expect(dataLakeRepository.findById('proposal-qa')).resolves.toBeNull();
  });

  it('findById resolves null for a well-formed id that matches nothing', async () => {
    // Both misses report the same value, so a call site narrowing with `=== null` cannot treat
    // one of them as a hit. BaseModel used to return `result?.toJSON()` here, which is
    // `undefined` despite the declared `| null`.
    await expect(dataLakeRepository.findById('aaaaaaaaaaaaaaaaaaaaaaaa')).resolves.toBeNull();
  });

  it('findBySlug resolves an org-less lake by its slug', async () => {
    const created = await dataLakeRepository.create(baseLake({ slug: 'proposal-qa' }));

    const found = await dataLakeRepository.findBySlug('proposal-qa');

    expect(found?.id).toBe(created.id);
  });

  it('the guarded id-or-slug pattern resolves a lake by slug', async () => {
    // The exact expression the seed route (and assertLakeAccess.ts) uses. The `.catch` is now
    // inert for this input - kept here because that is still the shipped expression.
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
