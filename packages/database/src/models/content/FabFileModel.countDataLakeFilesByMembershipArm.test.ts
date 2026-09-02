import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const CREATOR = 'creator-1';
const OTHER = 'other-1';

const makeFile = (overrides: {
  userId?: string;
  tags?: string[];
  fileName?: string;
  status?: string;
  deletedAt?: Date;
  archivedAt?: Date;
}) =>
  FabFile.create({
    userId: overrides.userId ?? CREATOR,
    fileName: overrides.fileName ?? 'doc',
    type: KnowledgeType.TEXT,
    tags: (overrides.tags ?? []).map(name => ({ name })),
    status: overrides.status ?? 'complete',
    deletedAt: overrides.deletedAt,
    archivedAt: overrides.archivedAt,
  });

const scope = (slug: string, prefix = '', creator: string | undefined = CREATOR) => ({
  kind: 'owned' as const,
  datalakeTag: `datalake:${slug}`,
  fileTagPrefix: prefix,
  creatorUserId: creator,
});

const registryScope = (slug: string, prefix: string) => ({
  kind: 'registry' as const,
  datalakeTag: `datalake:${slug}`,
  fileTagPrefix: prefix,
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

  it('reports prefixOnlyCount 0 for an owned lake with no creator to anchor the prefix arm to', async () => {
    await makeFile({ tags: ['datalake:registry'] });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('registry', '', undefined)]);

    expect(counts).toEqual({ 'datalake:registry': { metaCount: 1, prefixOnlyCount: 0 } });
  });

  it('counts a REGISTRY lake prefix-only file with no ownership conjunct', async () => {
    // A registry lake's prefix arm has no creator to anchor to - unlike an owned lake, a
    // prefix-only member from a DIFFERENT user still counts. This is the branch a scope with an
    // unusable (empty) prefix can never reach, regardless of `kind`.
    await makeFile({ tags: ['docs:legal'], userId: OTHER });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([registryScope('public-docs', 'docs:')]);

    expect(counts).toEqual({ 'datalake:public-docs': { metaCount: 0, prefixOnlyCount: 1 } });
  });

  it('counts a REGISTRY lake file carrying both signals only under metaCount, disjoint sum holds', async () => {
    await makeFile({ tags: ['datalake:public-docs', 'docs:legal'], userId: OTHER });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([registryScope('public-docs', 'docs:')]);

    expect(counts).toEqual({ 'datalake:public-docs': { metaCount: 1, prefixOnlyCount: 0 } });
    const combined = await fabFileRepository.countDataLakeFilesByMembership([registryScope('public-docs', 'docs:')]);
    expect(combined['datalake:public-docs']).toBe(
      counts['datalake:public-docs'].metaCount + counts['datalake:public-docs'].prefixOnlyCount
    );
  });

  it('excludes deleted, archived, and pending files from both counts', async () => {
    await makeFile({ tags: ['datalake:papers'], deletedAt: new Date() });
    await makeFile({ tags: ['datalake:papers'], archivedAt: new Date() });
    await makeFile({ tags: ['papers:draft'], status: 'pending' });

    const counts = await fabFileRepository.countDataLakeFilesByMembershipArm([scope('papers', 'papers:')]);

    expect(counts).toEqual({ 'datalake:papers': { metaCount: 0, prefixOnlyCount: 0 } });
  });

  it('returns an empty map when asked for no lakes', async () => {
    await expect(fabFileRepository.countDataLakeFilesByMembershipArm([])).resolves.toEqual({});
  });
});
