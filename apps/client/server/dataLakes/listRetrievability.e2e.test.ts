import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { DataLakeAccessGrantModel, DataLakeModel, Organization, Session } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { resolveRetrievalLakeScopeForUser } from './resolveRetrievalLakeScope';
import { labelLakeRetrievability } from './labelLakeRetrievability';
import { admitSessionLakes, findOwnSession } from './resolveLakeListRetrievalScope';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Runs the list label against the REAL retrieval resolver (the one chat turns share), so a row
 * labeled `true` is a lake chat would actually narrow against. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

const A = new mongoose.Types.ObjectId().toString();
const B = new mongoose.Types.ObjectId().toString();
const C = new mongoose.Types.ObjectId().toString();
const KEY = 'acme-premium';

type User = Parameters<typeof resolveRetrievalLakeScopeForUser>[0];
const userOf = (id: string, isAdmin = false) => ({ id, tags: [], isAdmin }) as unknown as User;

let server: Awaited<ReturnType<typeof createMongoServer>>;
let rows: { id: string; name: string; datalakeTag: string }[];
let MEMBER_ORG: string;
let ADMIN_ONLY_ORG: string;
const byName = (name: string) => rows.find(r => r.name === name)!;

const seedLake = async (name: string, createdByUserId: string, extra: Record<string, unknown> = {}) => {
  const doc = await DataLakeModel.create({
    name,
    slug: name,
    fileTagPrefix: `${name}:`,
    datalakeTag: `datalake:${name}`,
    createdByUserId,
    status: 'active',
    ...extra,
  });
  return { id: String(doc._id), name, datalakeTag: `datalake:${name}` };
};

const labelsFor = async (user: User, entitlementKeys: string[] = [], sessionId?: string) => {
  let scope = await resolveRetrievalLakeScopeForUser(user, { entitlementKeys, staticRegistryBypass: false });
  const session = await findOwnSession(sessionId, user.id);
  if (session) scope = await admitSessionLakes(scope, session, user.id);
  return Object.fromEntries(labelLakeRetrievability(rows, scope).map(r => [r.name, r.retrievable]));
};

const seedSession = async (userId: string, extra: Record<string, unknown> = {}) => {
  const now = new Date();
  const doc = await Session.create({ name: 's', userId, lastUpdated: now, firstCreated: now, ...extra });
  return String(doc._id);
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  MEMBER_ORG = String((await Organization.create({ name: 'member-org', userId: A }))._id);
  // A is an appointed admin of this org but not a member: it can manage (pre-authorize) the org's
  // lakes without retrieval reaching them.
  ADMIN_ONLY_ORG = String((await Organization.create({ name: 'admin-org', userId: C, adminUserIds: [A] }))._id);
  rows = [
    await seedLake('own', A),
    await seedLake('org-member', C, { organizationId: MEMBER_ORG }),
    await seedLake('org-managed', C, { organizationId: ADMIN_ONLY_ORG }),
    await seedLake('private-other', B),
    await seedLake('tag-gated', C, { requiredUserTag: 'acme-gold' }),
    await seedLake('own-draft', A, { status: 'draft' }),
    await seedLake('granted', C),
    await seedLake('entitlement-gated', C, { requiredEntitlement: KEY, isPublic: true }),
  ];
  const granted = rows.find(r => r.name === 'granted')!;
  await DataLakeAccessGrantModel.create({
    dataLakeId: granted.id,
    principalType: 'user',
    principalId: A,
    role: 'curator',
    grantedByUserId: C,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('GET /api/data-lakes retrievable label against the real retrieval resolver', () => {
  it('labels an admin caller by real chat reach, not admin browse reach', async () => {
    expect(await labelsFor(userOf(A, true), [KEY])).toEqual({
      own: true,
      'org-member': true,
      'org-managed': false,
      'private-other': false,
      'tag-gated': false,
      'own-draft': false,
      granted: true,
      'entitlement-gated': true,
    });
  });

  it('labels the private lake true for its own owner, and the entitlement lake false without the key', async () => {
    const labels = await labelsFor(userOf(B));
    expect(labels['private-other']).toBe(true);
    expect(labels['entitlement-gated']).toBe(false);
  });

  it('labels an org-scoped lake for a member and not for an outsider', async () => {
    expect((await labelsFor(userOf(A)))['org-member']).toBe(true);
    expect((await labelsFor(userOf(B)))['org-member']).toBe(false);
  });
});

describe('session-aware label (?sessionId=) against the shared chat admission', () => {
  it("admits a lake the caller's own session pre-authorizes and the caller still manages", async () => {
    const sid = await seedSession(A, { preauthorizedLakeIds: [byName('org-managed').id] });
    expect((await labelsFor(userOf(A), [], sid))['org-managed']).toBe(true);
    expect((await labelsFor(userOf(A)))['org-managed']).toBe(false);
  });

  it('does not admit a pre-authorized lake the caller can not manage, or a draft', async () => {
    const sid = await seedSession(A, { preauthorizedLakeIds: [byName('private-other').id, byName('own-draft').id] });
    const labels = await labelsFor(userOf(A), [], sid);
    expect(labels['private-other']).toBe(false);
    expect(labels['own-draft']).toBe(false);
  });

  it("treats another user's session as no session, even one that pre-authorizes a lake for its owner", async () => {
    const sid = await seedSession(B, { preauthorizedLakeIds: [byName('org-managed').id] });
    expect(await findOwnSession(sid, A)).toBeNull();
    expect(await labelsFor(userOf(A), [], sid)).toEqual(await labelsFor(userOf(A)));
  });

  it('treats a malformed or repeated session id as no session', async () => {
    expect(await findOwnSession('not-an-id', A)).toBeNull();
    expect(await findOwnSession(['a', 'b'], A)).toBeNull();
  });

  it('keeps a globally retrievable lake outside the session scope searchable, while chat narrows it out', async () => {
    const own = byName('own');
    const sid = await seedSession(A, { retrievalTags: [byName('granted').datalakeTag] });
    expect((await labelsFor(userOf(A), [], sid)).own).toBe(true);

    const session = (await findOwnSession(sid, A))!;
    const base = await resolveRetrievalLakeScopeForUser(userOf(A), {
      entitlementKeys: [],
      staticRegistryBypass: false,
    });
    const { searched } = await dataLakeService.resolveSessionLakeAdmission(
      base,
      { retrievalTags: session.retrievalTags },
      A,
      {}
    );
    expect(searched.lakes.map(l => l.datalakeTag)).toEqual([byName('granted').datalakeTag]);
    expect(searched.lakes.some(l => l.datalakeTag === own.datalakeTag)).toBe(false);
  });
});
