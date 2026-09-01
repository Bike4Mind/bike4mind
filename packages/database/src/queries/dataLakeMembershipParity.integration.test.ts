import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { FabFile, fabFileRepository } from '../models/content/FabFileModel';
import { buildDataLakeMembershipFilter } from './dataLakeLifecycleScope';
import { buildFabFileSearchQuery } from './fabFileSearchQuery';

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
    // A member still uploading. computeDataLakeStats drops `pending`; the browse has no status
    // clause at all, so this seed separates the two predicates.
    {
      userId: 'contributor',
      fileName: 'pending.txt',
      type: KnowledgeType.FILE,
      status: 'pending',
      filePath: 'pending',
      tags: [{ name: 'opti:inflight', strength: 1 }],
    },
    // A member carrying a sessionId. The browse excludes session summaries unconditionally;
    // computeDataLakeStats has no such clause - the divergence in the other direction.
    {
      userId: 'contributor',
      fileName: 'session.txt',
      type: KnowledgeType.FILE,
      status: 'complete',
      sessionId: 'session-1',
      filePath: 'session',
      tags: [{ name: 'opti:fromsession', strength: 1 }],
    },
  ]);
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

/**
 * The browse side, built the way GET /api/data-lakes/:id/articles builds it - through the real
 * search query rather than by re-deriving the membership filter. Comparing an aggregate and a find
 * over one hand-copied filter object is true by construction and cannot detect the two paths
 * drifting apart, which is the whole thing this file exists to watch.
 */
const browseFilter = (scope: Parameters<typeof buildDataLakeMembershipFilter>[0]) =>
  buildFabFileSearchQuery({
    userId: 'viewer',
    search: '',
    filters: { tags: [], shared: false },
    pagination: { page: 1, limit: 100 },
    order: { by: 'fileName', direction: 'asc' },
    options: { lakeMemberships: [scope], restrictToDataLake: true, includeShared: true, userGroups: [] },
  }).filter;

describe('stats and browse resolve the same membership', () => {
  it("a registry lake browses its prefix-only members, including another user's", async () => {
    const scope = { kind: 'registry' as const, datalakeTag: LAKE_TAG, fileTagPrefix: LAKE_PREFIX };

    const listed = await FabFile.find(browseFilter(scope)).select('fileName').lean();

    // The membership half - what this PR fixes. A prefix-only file owned by someone else IS a
    // member of a registry lake, and `both.txt` appears once despite matching both arms.
    expect(listed.map(f => f.fileName).sort()).toEqual(['both.txt', 'meta.txt', 'pending.txt', 'prefixed.txt']);
  });

  it('pins the REMAINING gap: membership now agrees, liveness still does not', async () => {
    const scope = { kind: 'registry' as const, datalakeTag: LAKE_TAG, fileTagPrefix: LAKE_PREFIX };

    const listed = await FabFile.find(browseFilter(scope)).select('fileName').lean();
    const stats = await fabFileRepository.computeDataLakeStats(scope);
    const listedNames = listed.map(f => f.fileName).sort();

    // Deliberately pinned as DIVERGENT rather than asserted away. The two paths now share one
    // membership predicate, but their liveness clauses still differ, in both directions:
    //   - computeDataLakeStats drops `status: 'pending'`; the browse has no status clause, so an
    //     in-flight upload is listed but not counted (the chip reads LOW);
    //   - the browse drops session summaries unconditionally; stats has no such clause, so a
    //     member carrying a sessionId is counted but not listed (the chip reads HIGH).
    //
    // Note what this fixture demonstrates: both errors are present and the totals still come out
    // EQUAL (4 and 4), because the two exclusions cancel. That is exactly why a count-only
    // assertion is a weak guard here - the sets differ while the numbers agree. Assert the
    // membership of each side, not its cardinality.
    //
    // Both gaps are transient and one or two files wide, unlike the permanent membership gap this
    // PR closes. Pinned so they stay visible and a later fix has a failing assertion to flip.
    expect(listedNames).toContain('pending.txt'); // listed, but not in fileCount
    expect(listedNames).not.toContain('session.txt'); // in fileCount, but not listed
    expect(stats.fileCount).toBe(4); // meta + both + prefixed + session
    expect(listed.length).toBe(4); // meta + both + prefixed + pending - same total, different set
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
