import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

/**
 * The `arm` field is computed in the aggregation pipeline, so it cannot be verified by a unit test
 * with a mocked model - `$in` against `$tags.name` either resolves against real documents or it does
 * not. These run against a real mongod for that reason.
 */
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({});
});

const CREATOR = 'creator1';
const SCOPE = {
  kind: 'owned' as const,
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  creatorUserId: CREATOR,
};

const makeFile = (over: Record<string, unknown> = {}) =>
  FabFile.create({
    userId: CREATOR,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    type: KnowledgeType.FILE,
    filePath: 'report.pdf',
    // The schema defaults `status` to 'pending', which the read excludes - so a fixture that omits
    // it is invisible and every assertion here would pass vacuously against an empty result.
    status: 'complete',
    ...over,
  });

describe('FabFileRepository.findDataLakeMembershipMembers', () => {
  it('labels a meta-tagged member as the meta-tag arm', async () => {
    await makeFile({ tags: [{ name: 'datalake:acme', strength: 1 }] });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows).toHaveLength(1);
    expect(rows[0].arm).toBe('meta-tag');
  });

  it('labels a prefix-only member as the prefix arm', async () => {
    // The supported shape #2243 is about: a member with no `datalake:*` tag at all, reachable by
    // retrieval only for principals the creator-anchored prefix arm admits.
    await makeFile({ tags: [{ name: 'acme:legal', strength: 1 }] });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows).toHaveLength(1);
    expect(rows[0].arm).toBe('prefix');
  });

  it('prefers the meta-tag label when a member carries both', async () => {
    await makeFile({
      tags: [
        { name: 'acme:legal', strength: 1 },
        { name: 'datalake:acme', strength: 1 },
      ],
    });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows[0].arm).toBe('meta-tag');
  });

  it('KEEPS a chunkless member, unlike the health read', async () => {
    // The population difference that makes this a separate query: a chunkless copy of a document is
    // exactly the duplicate an owner wants removed, and health drops it.
    await makeFile({ tags: [{ name: 'datalake:acme', strength: 1 }], chunkCount: 0 });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows).toHaveLength(1);
  });

  it('excludes deleted, archived and pending rows', async () => {
    const tags = [{ name: 'datalake:acme', strength: 1 }];
    await makeFile({ tags, fileName: 'deleted.pdf', deletedAt: new Date() });
    await makeFile({ tags, fileName: 'archived.pdf', archivedAt: new Date() });
    await makeFile({ tags, fileName: 'pending.pdf', status: 'pending' });
    await makeFile({ tags, fileName: 'live.pdf' });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows.map(r => r.fileName)).toEqual(['live.pdf']);
  });

  it('preserves an absent serverTextHash as null rather than dropping the field', async () => {
    // The summarizer refuses to prove identity from either form, but it has to RECEIVE something -
    // an absent key would arrive as undefined and read the same, by luck rather than contract.
    await makeFile({ tags: [{ name: 'datalake:acme', strength: 1 }] });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows[0]).toHaveProperty('serverTextHash', null);
  });

  it("does not admit another user's prefix-tagged file on the creator-anchored arm", async () => {
    await FabFile.create({
      userId: 'someone-else',
      fileName: 'theirs.pdf',
      mimeType: 'application/pdf',
      type: KnowledgeType.FILE,
      filePath: 'theirs.pdf',
      status: 'complete',
      tags: [{ name: 'acme:legal', strength: 1 }],
    });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows).toHaveLength(0);
  });

  it('fetches one extra row so the caller can detect overflow', async () => {
    const tags = [{ name: 'datalake:acme', strength: 1 }];
    for (let i = 0; i < 4; i++) await makeFile({ tags, fileName: `f${i}.pdf` });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE, 2);

    expect(rows).toHaveLength(3);
  });

  it('projects fileSize, and an absent one as null', async () => {
    // The size conjunct decides whether a group can be auto-collapsed, so a regression to `undefined`
    // here silently degrades every bucket. Its sibling `serverTextHash` is pinned above; this was the
    // one input to that rule with no assertion against a real mongod.
    const tags = [{ name: 'datalake:acme', strength: 1 }];
    await makeFile({ tags, fileName: 'sized.pdf', fileSize: 4096 });
    await makeFile({ tags, fileName: 'unsized.pdf' });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);
    const bySize = Object.fromEntries(rows.map(r => [r.fileName, r.fileSize]));

    expect(bySize['sized.pdf']).toBe(4096);
    expect(bySize['unsized.pdf']).toBeNull();
  });

  it("carries the member's owner, including one who is not the lake creator", async () => {
    // The meta-tag arm has no ownership conjunct, so another principal's tagged file IS a member -
    // the case the creator-anchored prefix arm above rejects. A same-name group can therefore span
    // owners, and the repair arm can only refuse to collapse across them if the owner is projected.
    await makeFile({ tags: [{ name: 'datalake:acme', strength: 1 }], fileName: 'shared.pdf' });
    await FabFile.create({
      userId: 'someone-else',
      fileName: 'shared.pdf',
      mimeType: 'application/pdf',
      type: KnowledgeType.FILE,
      filePath: 'shared.pdf',
      status: 'complete',
      tags: [{ name: 'datalake:acme', strength: 1 }],
    });

    const rows = await fabFileRepository.findDataLakeMembershipMembers(SCOPE);

    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.userId).sort()).toEqual([CREATOR, 'someone-else']);
  });
});

describe('FabFileRepository.findLakeMemberSiblingsByFileName', () => {
  const META = [{ name: 'datalake:acme', strength: 1 }];

  it('returns the same-name members of the lake, excluding the candidate', async () => {
    const candidate = await makeFile({ tags: META, createdAt: new Date('2026-03-01T00:00:00Z') });
    const sibling = await makeFile({ tags: META, createdAt: new Date('2026-01-01T00:00:00Z') });
    await makeFile({ tags: META, fileName: 'other.pdf' });

    const rows = await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', candidate.id);

    expect(rows.map(r => r.fabFileId)).toEqual([sibling.id]);
  });

  it('projects the identity signals the refinement reads', async () => {
    // The whole point of the read: without these two the admission checkpoint silently falls to the
    // bare file-name tier and stops distinguishing two same-named documents.
    const candidate = await makeFile({ tags: META });
    await makeFile({ tags: META, relativePath: 'docs/', driveFileId: 'd1' });

    const [row] = await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', candidate.id);

    expect(row.relativePath).toBe('docs/');
    expect(row.driveFileId).toBe('d1');
    // Absent is projected as null, not undefined - the pure grouping folds both, but the row type
    // promises null.
    expect(row.serverTextHash).toBeNull();
    expect(row.fileSize).toBeNull();
    expect(row.arm).toBe('meta-tag');
  });

  it('reaches prefix-only members, so a dynamic lake is not silently exempt', async () => {
    const candidate = await makeFile({ tags: META });
    const prefixOnly = await makeFile({ tags: [{ name: 'acme:legal', strength: 1 }] });

    const rows = await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', candidate.id);

    expect(rows.map(r => r.fabFileId)).toEqual([prefixOnly.id]);
    expect(rows[0].arm).toBe('prefix');
  });

  it('excludes deleted, archived and still-pending rows', async () => {
    const candidate = await makeFile({ tags: META });
    await makeFile({ tags: META, deletedAt: new Date() });
    await makeFile({ tags: META, archivedAt: new Date() });
    await makeFile({ tags: META, status: 'pending' });

    const rows = await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', candidate.id);

    expect(rows).toEqual([]);
  });

  it('never matches a member of a DIFFERENT lake', async () => {
    const candidate = await makeFile({ tags: META });
    await makeFile({ tags: [{ name: 'datalake:other', strength: 1 }] });

    const rows = await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', candidate.id);

    expect(rows).toEqual([]);
  });

  it('returns nothing for an empty name, rather than scanning the lake', async () => {
    const candidate = await makeFile({ tags: META });
    await makeFile({ tags: META });

    expect(await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, '', candidate.id)).toEqual([]);
  });

  it('returns nothing for an id that cannot address a row', async () => {
    // Fail-safe: the alternative is skipping the exclusion and reporting the admitted member as its
    // own duplicate.
    await makeFile({ tags: META });

    expect(await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', 'not-an-id')).toEqual([]);
  });

  it('keeps the NEWEST members when one name holds more copies than the bound', async () => {
    const candidate = await makeFile({ tags: META, createdAt: new Date('2026-01-01T00:00:00Z') });
    const newest = await makeFile({ tags: META, createdAt: new Date('2026-05-01T00:00:00Z') });
    await makeFile({ tags: META, createdAt: new Date('2026-02-01T00:00:00Z') });

    const rows = await fabFileRepository.findLakeMemberSiblingsByFileName(SCOPE, 'report.pdf', candidate.id, 1);

    expect(rows.map(r => r.fabFileId)).toEqual([newest.id]);
  });
});
