import { describe, it, expect, beforeEach } from 'vitest';
import type { IDataLakeAccessGrant } from '@bike4mind/common';
import {
  dataLakeAccessGrantRepository as repo,
  DataLakeAccessGrantModel,
  buildActiveGrantFilter,
} from './DataLakeAccessGrantModel';
import { setupMongoTest } from '../../__test__/utils';

const grant = (overrides: Partial<IDataLakeAccessGrant> = {}): IDataLakeAccessGrant => ({
  dataLakeId: 'lake-1',
  principalType: 'user',
  principalId: 'alice',
  role: 'reader',
  grantedByUserId: 'owner',
  ...overrides,
});

describe('buildActiveGrantFilter - the shared expiry predicate', () => {
  it('is empty when no asOf is given (lapsed grants are included)', () => {
    expect(buildActiveGrantFilter()).toEqual({});
  });

  it('admits never-expiring OR not-yet-expired grants at asOf', () => {
    const asOf = new Date('2026-06-01T00:00:00Z');
    expect(buildActiveGrantFilter(asOf)).toEqual({
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: asOf } }],
    });
  });
});

describe('DataLakeAccessGrantRepository', () => {
  setupMongoTest();
  // setupMongoTest's beforeEach dropDatabase()s (indexes included), and this model is not in its
  // one-time ensureIndexes list - rebuild the unique index per test so the collision case is real.
  beforeEach(async () => {
    await DataLakeAccessGrantModel.ensureIndexes();
  });

  it('upsert creates one row, then updates it in place on the (lake, principal) key', async () => {
    const created = await repo.upsertGrant(grant({ role: 'reader' }));
    expect(created.role).toBe('reader');
    expect(created.createdAt).toBeInstanceOf(Date);

    const updated = await repo.upsertGrant(grant({ role: 'curator', grantedByUserId: 'someone-else' }));
    expect(updated.id).toBe(created.id); // same row, not a second grant
    expect(updated.role).toBe('curator');
    expect(updated.grantedByUserId).toBe('someone-else');

    const all = await repo.listByLake('lake-1');
    expect(all).toHaveLength(1);
  });

  it('createdAt (granted-at) is preserved across a role change; updatedAt advances', async () => {
    const created = await repo.upsertGrant(grant({ role: 'reader' }));
    const updated = await repo.upsertGrant(grant({ role: 'owner' }));
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('enforces one grant per principal per lake via the unique index', async () => {
    await repo.upsertGrant(grant());
    // A raw create bypassing upsert must collide on the unique key.
    await expect(DataLakeAccessGrantModel.create(grant() as unknown as Record<string, unknown>)).rejects.toThrow(
      /duplicate key|E11000/i
    );
  });

  it('distinguishes principals that share an id but differ in type', async () => {
    await repo.upsertGrant(grant({ principalType: 'user', principalId: 'shared', role: 'reader' }));
    await repo.upsertGrant(grant({ principalType: 'organization', principalId: 'shared', role: 'curator' }));

    const user = await repo.findGrant('lake-1', 'user', 'shared');
    const org = await repo.findGrant('lake-1', 'organization', 'shared');
    expect(user?.role).toBe('reader');
    expect(org?.role).toBe('curator');
  });

  it('listByPrincipal returns a principal grants across lakes', async () => {
    await repo.upsertGrant(grant({ dataLakeId: 'lake-1', principalId: 'alice' }));
    await repo.upsertGrant(grant({ dataLakeId: 'lake-2', principalId: 'alice' }));
    await repo.upsertGrant(grant({ dataLakeId: 'lake-1', principalId: 'bob' }));

    const aliceLakes = (await repo.listByPrincipal('user', 'alice')).map(g => g.dataLakeId).sort();
    expect(aliceLakes).toEqual(['lake-1', 'lake-2']);
  });

  describe('expiry filtering (activeAsOf)', () => {
    const asOf = new Date('2026-06-01T00:00:00Z');
    const past = new Date('2026-01-01T00:00:00Z');
    const future = new Date('2026-12-01T00:00:00Z');

    it('drops expired grants but keeps never-expiring and future-dated ones', async () => {
      await repo.upsertGrant(grant({ principalId: 'never' })); // no expiresAt
      await repo.upsertGrant(grant({ principalId: 'future', expiresAt: future }));
      await repo.upsertGrant(grant({ principalId: 'lapsed', expiresAt: past }));

      const active = (await repo.listByLake('lake-1', { activeAsOf: asOf })).map(g => g.principalId).sort();
      expect(active).toEqual(['future', 'never']);

      // Without activeAsOf, the lapsed grant is still visible (audit / membership view).
      const everything = await repo.listByLake('lake-1');
      expect(everything).toHaveLength(3);
    });

    it('applies the same expiry rule to listByPrincipal', async () => {
      await repo.upsertGrant(grant({ dataLakeId: 'lake-1', principalId: 'carol', expiresAt: past }));
      await repo.upsertGrant(grant({ dataLakeId: 'lake-2', principalId: 'carol', expiresAt: future }));

      const active = await repo.listByPrincipal('user', 'carol', { activeAsOf: asOf });
      expect(active.map(g => g.dataLakeId)).toEqual(['lake-2']);
    });

    it('treats a grant expiring exactly at asOf as expired (strict >)', async () => {
      await repo.upsertGrant(grant({ principalId: 'edge', expiresAt: asOf }));
      const active = await repo.listByLake('lake-1', { activeAsOf: asOf });
      expect(active).toHaveLength(0);
    });
  });

  describe('clearing and updating expiry through upsert', () => {
    it('leaves an existing expiry untouched when expiresAt is omitted', async () => {
      const future = new Date('2026-12-01T00:00:00Z');
      await repo.upsertGrant(grant({ expiresAt: future }));
      await repo.upsertGrant(grant({ role: 'curator' })); // no expiresAt in the payload
      const found = await repo.findGrant('lake-1', 'user', 'alice');
      expect(found?.role).toBe('curator');
      expect(found?.expiresAt?.getTime()).toBe(future.getTime());
    });

    it('clears the expiry when expiresAt is explicitly null', async () => {
      await repo.upsertGrant(grant({ expiresAt: new Date('2026-12-01T00:00:00Z') }));
      await repo.upsertGrant(grant({ expiresAt: null }));
      const found = await repo.findGrant('lake-1', 'user', 'alice');
      expect(found?.expiresAt ?? null).toBeNull();
    });
  });

  describe('revocation', () => {
    it('removeGrant deletes a single principal grant and reports it', async () => {
      await repo.upsertGrant(grant({ principalId: 'alice' }));
      await repo.upsertGrant(grant({ principalId: 'bob' }));

      expect(await repo.removeGrant('lake-1', 'user', 'alice')).toBe(true);
      expect(await repo.removeGrant('lake-1', 'user', 'alice')).toBe(false); // already gone
      expect((await repo.listByLake('lake-1')).map(g => g.principalId)).toEqual(['bob']);
    });

    it('removeAllForLake cascades every grant on the lake and leaves others alone', async () => {
      await repo.upsertGrant(grant({ dataLakeId: 'lake-1', principalId: 'alice' }));
      await repo.upsertGrant(grant({ dataLakeId: 'lake-1', principalId: 'bob' }));
      await repo.upsertGrant(grant({ dataLakeId: 'lake-2', principalId: 'alice' }));

      expect(await repo.removeAllForLake('lake-1')).toBe(2);
      expect(await repo.listByLake('lake-1')).toHaveLength(0);
      expect(await repo.listByLake('lake-2')).toHaveLength(1);
    });
  });
});
