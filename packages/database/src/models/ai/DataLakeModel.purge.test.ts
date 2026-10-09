import { describe, expect, it } from 'vitest';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

const createLake = (slug: string) =>
  dataLakeRepository.create({
    name: slug,
    slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId: 'owner',
    status: 'deleted',
  });

describe('purge execution generation fencing', () => {
  setupMongoTest();

  it('keeps started cleanup hidden and allows only its same-generation retry', async () => {
    const lake = await createLake('started');
    await dataLakeRepository.claimPurging(lake.id, 'a');
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'a')).toBe(true);
    expect(await dataLakeRepository.releasePurgingToDeleted(lake.id, 'a')).toBe(false);
    expect(await dataLakeRepository.claimRestoring(lake.id)).toBe(false);
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'a')).toBe(true);
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'b')).toBe(false);
    expect(await dataLakeRepository.beginPurgeExecution(lake.id)).toBe(false);
  });

  it('recovers a lost acknowledgement only while its exact generation still owns the lake', async () => {
    const lake = await createLake('released');
    await dataLakeRepository.claimPurging(lake.id, 'a');
    expect(await dataLakeRepository.releasePurgingToDeleted(lake.id, 'a')).toBe(true);
    expect((await dataLakeRepository.findById(lake.id))?.purgeClaimId).toBe('a');
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'a')).toBe(true);
  });

  it('does not erase a newer generation when its enqueue fails', async () => {
    const lake = await createLake('newer');
    await dataLakeRepository.claimPurging(lake.id, 'a');
    await dataLakeRepository.releasePurgingToDeleted(lake.id, 'a');
    await dataLakeRepository.claimPurging(lake.id, 'b');
    await dataLakeRepository.releasePurgingToDeleted(lake.id, 'b');
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'a')).toBe(false);
    expect(await dataLakeRepository.beginPurgeExecution(lake.id)).toBe(false);
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'b')).toBe(true);
  });

  it.each(['keyed', 'legacy'])('fences delayed %s delivery after restore and another soft delete', async kind => {
    const lake = await createLake(`restore-${kind}`);
    const claim = kind === 'keyed' ? 'a' : undefined;
    if (claim) {
      await dataLakeRepository.claimPurging(lake.id, claim);
      await dataLakeRepository.releasePurgingToDeleted(lake.id, claim);
    }
    expect(await dataLakeRepository.claimRestoring(lake.id)).toBe(true);
    await dataLakeRepository.update({ id: lake.id, status: 'active' });
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, claim)).toBe(false);
    await dataLakeRepository.update({ id: lake.id, status: 'deleted' });
    expect(await dataLakeRepository.beginPurgeExecution(lake.id, claim)).toBe(false);
  });

  it('admits unkeyed legacy work only before a keyed generation exists', async () => {
    const lake = await createLake('legacy');
    expect(await dataLakeRepository.beginPurgeExecution(lake.id)).toBe(true);
    expect(await dataLakeRepository.beginPurgeExecution(lake.id)).toBe(true);
    expect(await dataLakeRepository.releasePurgingToDeleted(lake.id)).toBe(false);
  });
  it('refuses new claims and restore even if a started lake is marked deleted', async () => {
    const lake = await createLake('started-deleted');
    await dataLakeRepository.update({ id: lake.id, purgeStartedAt: new Date(), purgeClaimId: 'a' });
    expect(await dataLakeRepository.claimPurging(lake.id, 'b')).toBe(false);
    expect(await dataLakeRepository.claimRestoring(lake.id)).toBe(false);
  });

  it.each(['active', 'restoring'] as const)(
    'atomically rejects execution while %s even with a matching claim',
    async status => {
      const lake = await createLake(`state-${status}`);
      await dataLakeRepository.update({ id: lake.id, status, purgeClaimId: 'a' });
      expect(await dataLakeRepository.beginPurgeExecution(lake.id, 'a')).toBe(false);
      expect((await dataLakeRepository.findById(lake.id))?.purgeStartedAt).toBeUndefined();
    }
  );
});
