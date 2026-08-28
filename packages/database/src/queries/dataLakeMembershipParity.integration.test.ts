import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { buildDataLakeMembershipFilter } from './dataLakeLifecycleScope';

/**
 * The invariant whose absence let a lake's counts and its file list disagree: STATS and BROWSE must
 * resolve the same membership. They are computed by different code - an aggregate versus a find -
 * so a structural assertion on the filter object cannot catch a drift between them. Both run here
 * against a real server and their answers are compared.
 *
 * Registry lakes are the case that broke. Their members are reachable through the OPEN prefix arm,
 * which a creator-less scope used to drop, so `fileCount` reported a number the lake's own browse
 * contradicted.
 *
 * Its own file, with its own server: the sibling parity suite asserts over every document in the
 * collection, so seeding these fixtures alongside it silently changes that suite's expected sets.
 */

const LAKE_TAG = 'datalake:opti-knowledge';
const LAKE_PREFIX = 'opti:';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await FabFile.create([
    // Meta-tagged - the shape the ingest scripts write.
    {
      userId: 'ingestor',
      fileName: 'meta.txt',
      type: KnowledgeType.FILE,
      status: 'complete',
      filePath: 'meta',
      tags: [{ name: LAKE_TAG, strength: 1 }],
    },
    // Prefix-only, owned by SOMEONE ELSE. A registry lake is a shared KB, so this IS a member -
    // and it is invisible to the owned model, which is exactly the under-count being pinned.
    {
      userId: 'contributor',
      fileName: 'prefixed.txt',
      type: KnowledgeType.FILE,
      status: 'complete',
      filePath: 'prefixed',
      tags: [{ name: 'opti:solvers', strength: 1 }],
    },
    // Both signals - must count ONCE, not once per matching arm.
    {
      userId: 'ingestor',
      fileName: 'both.txt',
      type: KnowledgeType.FILE,
      status: 'complete',
      filePath: 'both',
      tags: [
        { name: LAKE_TAG, strength: 1 },
        { name: 'opti:duals', strength: 1 },
      ],
    },
    // Neither signal - never a member.
    {
      userId: 'stranger',
      fileName: 'unrelated.txt',
      type: KnowledgeType.FILE,
      status: 'complete',
      filePath: 'unrelated',
      tags: [{ name: 'globex:notes', strength: 1 }],
    },
  ]);
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

/** The liveness conditions computeDataLakeStats applies, so the browse compares like for like. */
const live = { deletedAt: null, archivedAt: null, status: { $ne: 'pending' } };

describe('stats and browse resolve the same membership', () => {
  it("a registry lake counts its prefix-only members, including another user's", async () => {
    const scope = { kind: 'registry' as const, datalakeTag: LAKE_TAG, fileTagPrefix: LAKE_PREFIX };

    const listed = await FabFile.find({ ...buildDataLakeMembershipFilter(scope), ...live })
      .select('fileName')
      .lean();
    const stats = await fabFileRepository.computeDataLakeStats(scope);

    expect(listed.map(f => f.fileName).sort()).toEqual(['both.txt', 'meta.txt', 'prefixed.txt']);
    // The assertion that matters: the number the product shows equals the list it shows.
    expect(stats.fileCount).toBe(listed.length);
  });

  it('the same lake under the owned model sees only the meta-tag - the pre-fix under-count', async () => {
    // No creator to anchor to, so the prefix arm drops. Pinned so a change that routes a registry
    // lake back through the owned model fails here rather than silently under-reporting.
    const stats = await fabFileRepository.computeDataLakeStats({
      kind: 'owned',
      datalakeTag: LAKE_TAG,
      fileTagPrefix: LAKE_PREFIX,
    });

    expect(stats.fileCount).toBe(2);
  });

  it('an owned lake still requires creator ownership on its prefix arm', async () => {
    const stats = await fabFileRepository.computeDataLakeStats({
      kind: 'owned',
      datalakeTag: LAKE_TAG,
      fileTagPrefix: LAKE_PREFIX,
      creatorUserId: 'ingestor',
    });

    // meta.txt + both.txt via the meta-tag. prefixed.txt stays out because 'contributor' is not the
    // creator - a DB lake must never absorb another user's prefix-tagged file.
    expect(stats.fileCount).toBe(2);
  });
});
