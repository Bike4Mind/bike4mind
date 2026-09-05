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
