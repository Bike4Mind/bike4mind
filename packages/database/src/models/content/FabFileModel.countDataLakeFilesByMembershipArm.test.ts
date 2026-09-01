import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const CREATOR = 'creator-1';
const OTHER = 'other-1';

const makeFile = (overrides: { userId?: string; tags?: string[]; fileName?: string }) =>
  FabFile.create({
    userId: overrides.userId ?? CREATOR,
    fileName: overrides.fileName ?? 'doc',
    type: KnowledgeType.TEXT,
    tags: (overrides.tags ?? []).map(name => ({ name })),
    status: 'complete',
  });

const scope = (slug: string, prefix = '', creator: string | undefined = CREATOR) => ({
  datalakeTag: `datalake:${slug}`,
  fileTagPrefix: prefix,
  creatorUserId: creator,
});

describe('FabFileRepository.countDataLakeFilesByMembershipArm', () => {
  setupMongoTest();

  it('counts a meta-tagged file under metaCount, not prefixOnlyCount', async () => {
    await makeFile({ tags: ['datalake:papers'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': { metaCount: 1, prefixOnlyCount: 0 } });
  });

  it('counts a creator-owned prefix-only file under prefixOnlyCount, not metaCount', async () => {
    await makeFile({ tags: ['papers:draft'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': { metaCount: 0, prefixOnlyCount: 1 } });
  });

  it('counts a file carrying both signals only under metaCount, so the two arms never double-count it', async () => {
    await makeFile({ tags: ['datalake:papers', 'papers:draft'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': { metaCount: 1, prefixOnlyCount: 0 } });
    // The two counts sum to the same total countDataLakeFilesByMembership would report.
    const combined = await fabFileRepository.countDataLakeFilesByMembership([scope('papers', 'papers:')]);
    expect(combined['datalake:papers']).toBe(
      counts['datalake:papers'].metaCount + counts['datalake:papers'].prefixOnlyCount
    );
  });

  it('ignores a prefix-tagged file owned by someone else in both arms', async () => {
    await makeFile({ tags: ['papers:draft'], userId: OTHER });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': { metaCount: 0, prefixOnlyCount: 0 } });
  });

  it('reports prefixOnlyCount 0 for a lake with no usable prefix arm', async () => {
    await makeFile({ tags: ['datalake:registry'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('registry', '', undefined)]);

    expect(counts).toEqual({ 'datalake:registry': { metaCount: 1, prefixOnlyCount: 0 } });
  });

  it('returns an empty map when asked for no lakes', async () => {
    await expect(fabFileRepository.countDataLakeFilesByMembershipArm([])).resolves.toEqual({});
  });
});
