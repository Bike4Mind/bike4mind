import { describe, it, expect } from 'vitest';
import type { DataLakeStatus, IDataLake } from '@bike4mind/common';
import { DataLakeModel, dataLakeRepository } from './DataLakeModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * A deleted or purging lake keeps reserving its slug but must not be reachable by it, or a by-slug
 * write (e.g. a content proposal) lands on a lake the user deleted. Every slug lookup arm must
 * apply the same filter; by-id lookups stay status-agnostic for restore and purge.
 */

const lake = (slug: string, status: DataLakeStatus, organizationId?: string): Omit<IDataLake, 'id'> =>
  ({
    name: slug,
    slug,
    fileTagPrefix: `${slug}:`,
    datalakeTag: organizationId ? `datalake:${organizationId}:${slug}` : `datalake:${slug}`,
    createdByUserId: 'owner-1',
    status,
    ...(organizationId ? { organizationId } : {}),
  }) as Omit<IDataLake, 'id'>;

const ORG = 'org-1';
const UNRESOLVABLE: DataLakeStatus[] = ['deleted', 'purging'];
const RESOLVABLE: DataLakeStatus[] = ['draft', 'active', 'archived', 'deleting'];

describe('DataLakeRepository slug lookups skip deleted and purging lakes', () => {
  setupMongoTest();

  it.each(UNRESOLVABLE)('a %s lake is unreachable by every slug arm, but still by id', async status => {
    const own = await dataLakeRepository.create(lake('own', status, ORG));
    const orgless = await dataLakeRepository.create(lake('orgless', status));

    await expect(dataLakeRepository.findBySlug('own', [ORG])).resolves.toBeNull();
    await expect(dataLakeRepository.findBySlug('orgless')).resolves.toBeNull();
    await expect(dataLakeRepository.findBySlugAmongIds('own', [own.id])).resolves.toBeNull();
    expect((await dataLakeRepository.findById(own.id))?.id).toBe(own.id);
    expect((await dataLakeRepository.findById(orgless.id))?.id).toBe(orgless.id);
  });

  it.each(UNRESOLVABLE)('a %s lake in one org does not shadow an active same-slug lake elsewhere', async status => {
    await dataLakeRepository.create(lake('shared', status, 'org-a'));
    const activeInOrgB = await dataLakeRepository.create(lake('shared', 'active', 'org-b'));
    expect((await dataLakeRepository.findBySlug('shared', ['org-a', 'org-b']))?.id).toBe(activeInOrgB.id);

    const dead = await dataLakeRepository.create(lake('granted', status, 'org-c'));
    const active = await dataLakeRepository.create(lake('granted', 'active', 'org-d'));
    expect((await dataLakeRepository.findBySlugAmongIds('granted', [dead.id, active.id]))?.id).toBe(active.id);
  });

  it.each(RESOLVABLE)('a %s lake still resolves by every slug arm', async status => {
    const own = await dataLakeRepository.create(lake('own', status, ORG));
    const orgless = await dataLakeRepository.create(lake('orgless', status));

    expect((await dataLakeRepository.findBySlug('own', [ORG]))?.id).toBe(own.id);
    expect((await dataLakeRepository.findBySlug('orgless'))?.id).toBe(orgless.id);
    expect((await dataLakeRepository.findBySlugAmongIds('own', [own.id]))?.id).toBe(own.id);
  });

  it('a legacy lake with no status field still resolves by slug', async () => {
    // Raw insert: the repository would stamp a status, and $nin must keep matching rows without one.
    const { insertedId } = await DataLakeModel.collection.insertOne({ ...lake('legacy', 'active'), status: undefined });
    await DataLakeModel.collection.updateOne({ _id: insertedId }, { $unset: { status: '' } });

    expect((await dataLakeRepository.findBySlug('legacy'))?.id).toBe(insertedId.toString());
  });

  it('a deleted own-org lake falls through to an org-less lake sharing its slug', async () => {
    // Consistent with the arm order (own org first, then org-less), but new: before the filter
    // the deleted own-org lake would have won.
    await dataLakeRepository.create(lake('shared', 'deleted', ORG));
    const orgless = await dataLakeRepository.create(lake('shared', 'active'));

    expect((await dataLakeRepository.findBySlug('shared', [ORG]))?.id).toBe(orgless.id);
  });
});
