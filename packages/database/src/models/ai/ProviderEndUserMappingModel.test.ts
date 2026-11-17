import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { ProviderEndUserMapping, providerEndUserMappingRepository as repo } from './ProviderEndUserMappingModel';
import { setupMongoTest } from '../../__test__/utils';

const DIGEST = 'ab'.repeat(32);
const OWNER = new Types.ObjectId().toString();

describe('ProviderEndUserMappingRepository', () => {
  setupMongoTest();
  beforeEach(async () => {
    await ProviderEndUserMapping.ensureIndexes();
  });

  it('creates the row on first sight and only moves lastSeenAt afterwards', async () => {
    const first = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-02-01T00:00:00Z');
    await repo.recordSeen({ providerEndUserId: DIGEST, ownerUserId: OWNER, endUserId: 'player-1' }, first);
    await repo.recordSeen({ providerEndUserId: DIGEST, ownerUserId: OWNER, endUserId: 'ignored' }, later);

    const rows = await ProviderEndUserMapping.find({ providerEndUserId: DIGEST }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].ownerUserId)).toBe(OWNER);
    expect(rows[0].endUserId).toBe('player-1');
    expect(rows[0].firstSeenAt).toEqual(first);
    expect(rows[0].lastSeenAt).toEqual(later);
  });

  it('finds a row by digest and deletes all rows of an owner', async () => {
    await repo.recordSeen({ providerEndUserId: DIGEST, ownerUserId: OWNER, endUserId: 'player-1' });
    await repo.recordSeen({ providerEndUserId: 'cd'.repeat(32), ownerUserId: OWNER, endUserId: 'player-2' });

    const found = await repo.findByProviderEndUserId(DIGEST);
    expect(found?.endUserId).toBe('player-1');
    expect(await repo.findByProviderEndUserId('ef'.repeat(32))).toBeNull();

    expect(await repo.deleteAllForOwner(OWNER)).toBe(2);
    expect(await ProviderEndUserMapping.countDocuments()).toBe(0);
  });
});
