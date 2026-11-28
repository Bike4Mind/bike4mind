import { describe, it, expect } from 'vitest';
import type { DataLakeStatus, IDataLake } from '@bike4mind/common';
import { DataLakeModel, dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

const lake = (
  slug: string,
  gate: Pick<IDataLake, 'requiredUserTag' | 'requiredEntitlement'>,
  status: DataLakeStatus = 'active'
): Omit<IDataLake, 'id'> =>
  ({
    name: slug,
    slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: `datalake:${slug}`,
    createdByUserId: 'owner-1',
    status,
    ...gate,
  }) as Omit<IDataLake, 'id'>;

describe('DataLakeRepository.findGateValues', () => {
  setupMongoTest();

  it('returns every stored gate value across statuses and skips blanks', async () => {
    await dataLakeRepository.create(lake('tagged', { requiredUserTag: 'Partner-Beta' }));
    await dataLakeRepository.create(lake('keyed', { requiredEntitlement: 'Acme:Pro' }, 'archived'));
    await dataLakeRepository.create(lake('gone', { requiredUserTag: 'old-cohort' }, 'deleted'));
    await dataLakeRepository.create(lake('blank', { requiredUserTag: '', requiredEntitlement: '' }));
    await dataLakeRepository.create(lake('open', {}));

    const { userTags, entitlements } = await dataLakeRepository.findGateValues();

    expect(userTags.sort()).toEqual(['Partner-Beta', 'old-cohort'].sort());
    expect(entitlements).toEqual(['acme:pro']);
  });

  it('returns empty lists when no lake is gated', async () => {
    await DataLakeModel.create(lake('open', {}));
    await expect(dataLakeRepository.findGateValues()).resolves.toEqual({ userTags: [], entitlements: [] });
  });
});
