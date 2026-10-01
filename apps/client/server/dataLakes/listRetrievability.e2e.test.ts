import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { DataLakeAccessGrantModel, DataLakeModel } from '@bike4mind/database';
import { resolveRetrievalLakeScopeForUser } from './resolveRetrievalLakeScope';
import { labelLakeRetrievability } from './labelLakeRetrievability';

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

const labelsFor = async (user: User, entitlementKeys: string[] = []) => {
  const scope = await resolveRetrievalLakeScopeForUser(user, { entitlementKeys, staticRegistryBypass: false });
  return Object.fromEntries(labelLakeRetrievability(rows, scope).map(r => [r.name, r.retrievable]));
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  rows = [
    await seedLake('own', A),
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
});
