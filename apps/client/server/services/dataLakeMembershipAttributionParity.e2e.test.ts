/**
 * Parity guard: `attributeFileToLakeIds` (@bike4mind/services) is the in-memory mirror of
 * `buildDataLakeMembershipFilter` (@bike4mind/database), which is the AUTHORITY on who is a member
 * of a lake - it drives the single-lake browse and every whole-lake lifecycle write, including a
 * hard delete.
 *
 * The mirror exists because supersession collapse has to decide, per file and with no query, which
 * lake a scoped file belongs to. Two implementations of one rule drift; the specific way this pair
 * would drift is the ownership conjunct on the dynamic prefix arm, whose absence would let one
 * lake's user-chosen prefix reach another tenant's files. So both are run over the SAME real
 * collection here and their member sets compared, rather than asserting on a filter object - a
 * structural assertion is true by construction and cannot see the two answers diverge.
 *
 * Lives in apps/client because it is the only package that depends on both.
 * Consumes the built dist, so `pnpm turbo:core:build` must be current.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, buildDataLakeMembershipFilter } from '@bike4mind/database';
import { KnowledgeType, type DataLakeMembershipScope } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { vi } from 'vitest';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;

const CREATOR = 'creator-1';
const OUTSIDER = 'someone-else';
const LAKE_TAG = 'datalake:acme';
const PREFIX = 'acme:';

/** The dynamic (DB) lake: prefix arm anchored to the creator. */
const OWNED_SCOPE: DataLakeMembershipScope = {
  kind: 'owned',
  datalakeTag: LAKE_TAG,
  fileTagPrefix: PREFIX,
  creatorUserId: CREATOR,
};
const OWNED_LAKE = { id: 'lake-acme', datalakeTag: LAKE_TAG, fileTagPrefix: PREFIX, membership: OWNED_SCOPE };

const seed = (fileName: string, userId: string, tagNames: string[]) => ({
  userId,
  fileName,
  type: KnowledgeType.FILE,
  status: 'complete',
  filePath: fileName,
  tags: tagNames.map(name => ({ name, strength: 1 })),
});

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await FabFile.create([
    // Meta-tagged, creator's. A member by either arm.
    seed('meta-creator.txt', CREATOR, [LAKE_TAG]),
    // Meta-tagged, someone else's. The meta arm carries no ownership conjunct, so still a member.
    seed('meta-outsider.txt', OUTSIDER, [LAKE_TAG]),
    // Prefix-only, creator's. THE case this whole change exists for.
    seed('prefix-creator.txt', CREATOR, ['acme:hr']),
    // Prefix-only, someone else's - an admin's upload into the lake is the documented shape. NOT a
    // member: the conjunct is positive ownership, and this is the direction that must stay refused.
    seed('prefix-outsider.txt', OUTSIDER, ['acme:hr']),
    // A bare prefix with no suffix genuinely IS membership for the read arm.
    seed('bare-prefix.txt', CREATOR, ['acme:']),
    // Case variants do not satisfy the read arm's unflagged regex.
    seed('wrong-case.txt', CREATOR, ['Acme:hr']),
    // Contains the prefix but does not start with it.
    seed('not-anchored.txt', CREATOR, ['not-acme:hr']),
    // Both signals - must resolve once, not once per arm.
    seed('both.txt', CREATOR, [LAKE_TAG, 'acme:legal']),
    // Neither signal.
    seed('unrelated.txt', CREATOR, ['globex:notes']),
    // No tags at all.
    seed('untagged.txt', CREATOR, []),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

/** The datastore's answer: whom the authoritative predicate selects. */
const membersPerDatabase = async (scope: DataLakeMembershipScope) => {
  const rows = await FabFile.find(buildDataLakeMembershipFilter(scope)).select('fileName').lean();
  return rows.map(r => r.fileName as string).sort();
};

/** The in-memory answer: whom attribution reverses to this lake, file by file. */
const membersPerAttribution = async (lake: typeof OWNED_LAKE) => {
  const rows = await FabFile.find({}).select('fileName userId tags').lean();
  return rows
    .filter(r => {
      const tagNames = (r.tags ?? []).map((t: { name?: string }) => t.name) as string[];
      return dataLakeService.attributeFileToLakeIds(tagNames, [lake], r.userId as string).includes(lake.id);
    })
    .map(r => r.fileName as string)
    .sort();
};

describe('attribution and the membership predicate resolve the same members', () => {
  it('agrees file for file on a dynamic lake, including the prefix arm', async () => {
    const fromDb = await membersPerDatabase(OWNED_SCOPE);
    const fromAttribution = await membersPerAttribution(OWNED_LAKE);

    // Pinned explicitly as well as compared, so a change that breaks BOTH sides identically still
    // fails here rather than passing as "they agree".
    // `bare-prefix.txt` is in the set: a bare `acme:` with no suffix matches the read arm's
    // `^acme:` regex, so it is membership even though it is not a navigable tag-tree category.
    expect(fromDb).toEqual([
      'bare-prefix.txt',
      'both.txt',
      'meta-creator.txt',
      'meta-outsider.txt',
      'prefix-creator.txt',
    ]);
    expect(fromAttribution).toEqual(fromDb);
  });

  it('agrees that a creator-less lake row falls back to meta-tag-only', async () => {
    const creatorless: DataLakeMembershipScope = { ...OWNED_SCOPE, creatorUserId: null };
    const fromDb = await membersPerDatabase(creatorless);
    const fromAttribution = await membersPerAttribution({ ...OWNED_LAKE, membership: creatorless });

    expect(fromDb).toEqual(['both.txt', 'meta-creator.txt', 'meta-outsider.txt']);
    expect(fromAttribution).toEqual(fromDb);
  });

  it('agrees that a reserved-namespace prefix is dropped by both sides', async () => {
    const reserved: DataLakeMembershipScope = { ...OWNED_SCOPE, fileTagPrefix: 'datalake:' };
    const fromDb = await membersPerDatabase(reserved);
    const fromAttribution = await membersPerAttribution({ ...OWNED_LAKE, membership: reserved });

    // Not every `datalake:*` file - only the lake's own meta-tag. A reserved prefix would otherwise
    // match every OTHER lake's membership tag.
    expect(fromDb).toEqual(['both.txt', 'meta-creator.txt', 'meta-outsider.txt']);
    expect(fromAttribution).toEqual(fromDb);
  });

  /**
   * The security property in its own test, because it is the reason the prefix arm was refused
   * outright before this and the reason it is safe now. `bare-prefix.txt` is the interesting row:
   * it IS a member for the creator, so a mirror that dropped the ownership conjunct would attribute
   * it - and every other `acme:*` file - to a lake minted by anyone.
   */
  it("never attributes another user's prefix-only file, which is what makes the arm safe", async () => {
    const fromAttribution = await membersPerAttribution(OWNED_LAKE);
    expect(fromAttribution).not.toContain('prefix-outsider.txt');

    // Same lake config, a DIFFERENT creator: the creator's own prefix-only files stop being members
    // and the outsider's become them. Nothing about the tags changed - only who owns what.
    const rebased: DataLakeMembershipScope = { ...OWNED_SCOPE, creatorUserId: OUTSIDER };
    const fromDb = await membersPerDatabase(rebased);
    const rebasedAttribution = await membersPerAttribution({ ...OWNED_LAKE, membership: rebased });
    expect(rebasedAttribution).toEqual(fromDb);
    expect(rebasedAttribution).toContain('prefix-outsider.txt');
    expect(rebasedAttribution).not.toContain('prefix-creator.txt');
  });
});
