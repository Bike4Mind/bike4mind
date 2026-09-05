import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType, type DataLakeMembershipScope } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, buildDataLakeMembershipQuery } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * PARITY guard for the two implementations of one membership rule (#2243):
 * `satisfiesMembershipScope` (`@bike4mind/services`, the in-memory mirror) against
 * `buildDataLakeMembershipFilter` (`@bike4mind/database`, the Mongo predicate every whole-lake
 * query runs on). The mirror exists because `retrieve_knowledge_content`'s direct-fetch path holds
 * the document already and must not re-ask the database whether it is a member.
 *
 * Behaviour is covered at the call site (`knowledgeBaseRetrieve/index.test.ts`, both the positive
 * and the cross-tenant negative). What only a parity test catches is DRIFT: a change to either
 * side that leaves both individually passing while they disagree on some input. A disagreement in
 * the strict direction silently denies a prefix-only member the file that search just offered
 * them; in the loose direction it opens a file the query would not have matched.
 *
 * Lives in `apps/client` because it is the only package depending on BOTH `@bike4mind/database`
 * and `@bike4mind/services` - the mirror cannot be tested against the predicate from either
 * package alone. It matches through the REAL Mongo predicate rather than an in-memory matcher, so
 * the regex semantics being asserted are the ones mongod actually applies.
 *
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 *
 * The matrix pairs every fixture with every scope and asserts the two agree on all of them, so a
 * new edge case is one row rather than one test.
 */

const CREATOR = 'u-creator';
const STRANGER = 'u-stranger';
const TAG = 'datalake:org1:acme-docs';
const PREFIX = 'acme:';

let server: Awaited<ReturnType<typeof createMongoServer>>;

const makeFile = (label: string, userId: string, tagNames: string[]) =>
  FabFile.create({
    fileName: `${label}.txt`,
    filePath: `${label}.txt`,
    userId,
    tags: tagNames.map(name => ({ name })),
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    fileSize: 100,
    status: 'complete',
  });

/**
 * Each fixture names an axis on which the regex arm and `startsWith` could diverge. `bare-prefix`
 * and `newline-in-tag` are the two that a mirror built on `satisfiesTagPrefix` would get wrong
 * (it requires a suffix, and `.` excludes newlines); `dot-collision` is the one an unescaped
 * metacharacter in the prefix would get wrong.
 */
const FIXTURES: { label: string; userId: string; tags: string[] }[] = [
  { label: 'meta-creator', userId: CREATOR, tags: [TAG] },
  { label: 'meta-stranger', userId: STRANGER, tags: [TAG] },
  { label: 'prefix-creator', userId: CREATOR, tags: ['acme:report'] },
  { label: 'prefix-stranger', userId: STRANGER, tags: ['acme:report'] },
  { label: 'bare-prefix-creator', userId: CREATOR, tags: ['acme:'] },
  { label: 'meta-and-prefix-stranger', userId: STRANGER, tags: [TAG, 'acme:report'] },
  { label: 'case-mismatch-creator', userId: CREATOR, tags: ['ACME:report'] },
  { label: 'newline-in-tag-creator', userId: CREATOR, tags: ['acme:\nreport'] },
  { label: 'dot-collision-creator', userId: CREATOR, tags: ['abc:report'] },
  { label: 'other-prefix-creator', userId: CREATOR, tags: ['globex:report'] },
  { label: 'untagged-creator', userId: CREATOR, tags: [] },
];

/** Every fail-closed branch of the predicate plus the anchored happy path. */
const SCOPES: { label: string; scope: DataLakeMembershipScope }[] = [
  { label: 'anchored', scope: { datalakeTag: TAG, fileTagPrefix: PREFIX, creatorUserId: CREATOR } },
  { label: 'creator is a stranger', scope: { datalakeTag: TAG, fileTagPrefix: PREFIX, creatorUserId: STRANGER } },
  // '' is a real reachable value: the synthetic registry-lake fallback has no backing creator.
  { label: 'empty creator', scope: { datalakeTag: TAG, fileTagPrefix: PREFIX, creatorUserId: '' } },
  { label: 'null creator', scope: { datalakeTag: TAG, fileTagPrefix: PREFIX, creatorUserId: null } },
  { label: 'no prefix', scope: { datalakeTag: TAG, fileTagPrefix: null, creatorUserId: CREATOR } },
  { label: 'reserved prefix', scope: { datalakeTag: TAG, fileTagPrefix: 'datalake:', creatorUserId: CREATOR } },
  { label: 'regex metacharacter prefix', scope: { datalakeTag: TAG, fileTagPrefix: 'a.c:', creatorUserId: CREATOR } },
];

let rows: { label: string; id: string; file: { userId: string; tags: { name: string }[] } }[];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  rows = await Promise.all(
    FIXTURES.map(async f => {
      const doc = await makeFile(f.label, f.userId, f.tags);
      const json = doc.toJSON() as { userId: string; tags: { name: string }[] };
      return { label: f.label, id: String(doc._id), file: { userId: json.userId, tags: json.tags } };
    })
  );
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

/** True when the REAL Mongo predicate matches this row - the authority the mirror must track. */
const matchedByMongo = async (scope: DataLakeMembershipScope, id: string): Promise<boolean> =>
  (await FabFile.exists(buildDataLakeMembershipQuery(scope, { _id: id }))) !== null;

describe('satisfiesMembershipScope parity with buildDataLakeMembershipFilter (#2243)', () => {
  for (const { label: scopeLabel, scope } of SCOPES) {
    it(`agrees with the Mongo predicate on every fixture - scope: ${scopeLabel}`, async () => {
      const mongoVerdicts: Record<string, boolean> = {};
      const mirrorVerdicts: Record<string, boolean> = {};
      for (const row of rows) {
        mongoVerdicts[row.label] = await matchedByMongo(scope, row.id);
        mirrorVerdicts[row.label] = dataLakeService.satisfiesMembershipScope(scope, row.file);
      }
      expect(mirrorVerdicts).toEqual(mongoVerdicts);
    });
  }

  it('the matrix separates members from non-members, so agreement is not vacuous', async () => {
    // Without this, a mirror (or a predicate) that answered `false` for every input would satisfy
    // every assertion above. Asserts the fixtures actually straddle the boundary.
    const anchored = SCOPES[0].scope;
    const verdicts = await Promise.all(rows.map(row => matchedByMongo(anchored, row.id)));
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(0);
    expect(verdicts.filter(v => !v).length).toBeGreaterThan(0);
  });

  it('a missing file is not a member, on the arm the mirror has to answer alone', () => {
    // The one input the Mongo side cannot be asked about: the direct-fetch path can hold `null`
    // when the id resolved to nothing, and must fail closed rather than throw.
    const anchored = SCOPES[0].scope;
    expect(dataLakeService.satisfiesMembershipScope(anchored, null)).toBe(false);
    expect(dataLakeService.satisfiesMembershipScope(anchored, undefined)).toBe(false);
  });
});
