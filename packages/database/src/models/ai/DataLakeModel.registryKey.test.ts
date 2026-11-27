import { describe, it, expect } from 'vitest';
import { DATA_LAKES, type IDataLake } from '@bike4mind/common';
import { dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

const REGISTRY_KEY = DATA_LAKES[0].id;

const lake = (slug: string, organizationId?: string): Omit<IDataLake, 'id'> =>
  ({
    name: slug,
    slug,
    fileTagPrefix: `${slug}-${organizationId ?? 'none'}:`,
    datalakeTag: organizationId ? `datalake:${organizationId}:${slug}` : `datalake:legacy-${slug}`,
    createdByUserId: 'owner-1',
    status: 'active',
    ...(organizationId ? { organizationId } : {}),
  }) as Omit<IDataLake, 'id'>;

describe('DataLakeRepository slug lookups for a registry lake key', () => {
  setupMongoTest();

  it('never resolves an org-less lake by a registry key', async () => {
    const orgless = await dataLakeRepository.create(lake(REGISTRY_KEY));

    await expect(dataLakeRepository.findBySlug(REGISTRY_KEY)).resolves.toBeNull();
    await expect(dataLakeRepository.findBySlug(REGISTRY_KEY, ['org-1'])).resolves.toBeNull();
    await expect(dataLakeRepository.findBySlugAmongIds(REGISTRY_KEY, [orgless.id])).resolves.toBeNull();
    expect((await dataLakeRepository.findById(orgless.id))?.id).toBe(orgless.id);
  });

  it('still resolves an org-scoped lake holding a registry key for its org and its grant holders', async () => {
    const own = await dataLakeRepository.create(lake(REGISTRY_KEY, 'org-1'));

    expect((await dataLakeRepository.findBySlug(REGISTRY_KEY, ['org-1']))?.id).toBe(own.id);
    await expect(dataLakeRepository.findBySlug(REGISTRY_KEY, ['org-2'])).resolves.toBeNull();
    expect((await dataLakeRepository.findBySlugAmongIds(REGISTRY_KEY, [own.id]))?.id).toBe(own.id);
  });

  it('leaves org-less lookups of other slugs unchanged', async () => {
    const orgless = await dataLakeRepository.create(lake('ordinary'));

    expect((await dataLakeRepository.findBySlug('ordinary'))?.id).toBe(orgless.id);
    expect((await dataLakeRepository.findBySlugAmongIds('ordinary', [orgless.id]))?.id).toBe(orgless.id);
  });
});
