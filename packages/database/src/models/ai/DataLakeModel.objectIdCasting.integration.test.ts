import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { AccessContext } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { DataLakeModel, dataLakeRepository } from './DataLakeModel';

/**
 * Run against a real server because the behaviour under test IS Mongo's casting. Grant rows store
 * `dataLakeId` as a plain String (DataLakeAccessGrantModel), so a malformed one reaches these
 * `_id: { $in: [...] }` arms and CastErrors the WHOLE query - on the retrieval path that is a
 * silent, total loss of grounding. Each door below has to survive one bad id AND must not fall
 * open when every id is bad.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const JUNK_ID = 'legacy-uuid-not-an-objectid';
const OTHER_USER = 'lake-owner-1';
const GRANTING_ORG = 'org-A';

let server: Awaited<ReturnType<typeof createMongoServer>>;
// Org-less and gate-less, created by someone else: Private-by-default puts it out of every arm
// except an explicit grant, so its presence in a result proves the grant arm fired.
let grantOnlyId: string;
// Same, but scoped to an org the viewer does not belong to - reachable only via an ORG grant.
let orgGrantOnlyId: string;
// Public but gated on a tag the viewer lacks: findPublicLakes admits it only via a grant.
let publicGatedId: string;
// Same, plus scoped to the granting org - the only fixture findPublicLakes can reach through the
// ORG half of the grant, which is a separate arm from the user half above.
let publicOrgGatedId: string;

const viewer: AccessContext = {
  userId: 'viewer-1',
  isAdmin: false,
  userTags: [],
  entitlementKeys: [],
  organizationIds: [],
};

const seedLake = async (fields: Record<string, unknown>): Promise<string> => {
  const lake = await DataLakeModel.create({
    name: `lake-${fields.slug}`,
    fileTagPrefix: `${fields.slug}:`,
    datalakeTag: `dl-${fields.slug}`,
    createdByUserId: OTHER_USER,
    status: 'active',
    ...fields,
  });
  return String(lake._id);
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  grantOnlyId = await seedLake({ slug: 'grant-only' });
  orgGrantOnlyId = await seedLake({ slug: 'org-grant-only', organizationId: GRANTING_ORG });
  publicGatedId = await seedLake({ slug: 'public-gated', isPublic: true, requiredUserTag: 'vip' });
  publicOrgGatedId = await seedLake({
    slug: 'public-org-gated',
    isPublic: true,
    requiredUserTag: 'vip',
    organizationId: GRANTING_ORG,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('findAccessible', () => {
  it('serves the grant-held lake when the grant set also holds an uncastable id', async () => {
    const lakes = await dataLakeRepository.findAccessible(viewer, {
      grantedLakeIds: [JUNK_ID, grantOnlyId],
    });
    expect(lakes.map(l => String(l.id))).toEqual([grantOnlyId]);
  });

  it('drops the grant arm rather than widening when no granted id is castable', async () => {
    const lakes = await dataLakeRepository.findAccessible(viewer, { grantedLakeIds: [JUNK_ID] });
    expect(lakes).toEqual([]);
  });

  it('serves the org-granted lake when that org arm also holds an uncastable id', async () => {
    const lakes = await dataLakeRepository.findAccessible(viewer, {
      orgGrantedLakes: { [GRANTING_ORG]: [JUNK_ID, orgGrantOnlyId] },
    });
    expect(lakes.map(l => String(l.id))).toEqual([orgGrantOnlyId]);
  });

  it('drops an org arm whose ids are all uncastable, leaving the org unreachable', async () => {
    const lakes = await dataLakeRepository.findAccessible(viewer, {
      orgGrantedLakes: { [GRANTING_ORG]: [JUNK_ID] },
    });
    expect(lakes).toEqual([]);
  });
});

describe('findActiveByUserTagsAndEntitlements', () => {
  it('serves the grant-held lake when the grant set also holds an uncastable id', async () => {
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], [], viewer.userId, {
      grantedLakeIds: [JUNK_ID, grantOnlyId],
    });
    expect(lakes.map(l => String(l.id))).toEqual([grantOnlyId]);
  });

  it('serves the org-granted lake when that org arm also holds an uncastable id', async () => {
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], [], viewer.userId, {
      orgGrantedLakes: { [GRANTING_ORG]: [JUNK_ID, orgGrantOnlyId] },
    });
    expect(lakes.map(l => String(l.id))).toEqual([orgGrantOnlyId]);
  });

  // Split per arm, not asserted together: a regression in only one guard still leaves the combined
  // result empty, so a single test cannot say which one held.
  it('drops the user-grant arm rather than widening when no granted id is castable', async () => {
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], [], viewer.userId, {
      grantedLakeIds: [JUNK_ID],
    });
    expect(lakes).toEqual([]);
  });

  it('drops the org-grant arm rather than widening when no granted id is castable', async () => {
    const lakes = await dataLakeRepository.findActiveByUserTagsAndEntitlements([], [], [], viewer.userId, {
      orgGrantedLakes: { [GRANTING_ORG]: [JUNK_ID] },
    });
    expect(lakes).toEqual([]);
  });
});

describe('findPublicLakes', () => {
  it('lifts the post-publish gate for the grant-held lake despite an uncastable id', async () => {
    const { lakes, total } = await dataLakeRepository.findPublicLakes(viewer, {
      grantedLakeIds: [JUNK_ID, publicGatedId],
    });
    expect(lakes.map(l => String(l.id))).toEqual([publicGatedId]);
    expect(total).toBe(1);
  });

  it('keeps the gate up when no granted id is castable', async () => {
    const { lakes, total } = await dataLakeRepository.findPublicLakes(viewer, { grantedLakeIds: [JUNK_ID] });
    expect(lakes).toEqual([]);
    expect(total).toBe(0);
  });

  // The org half routes through the same shared `orgGrantArms` helper, but this is the third call
  // site feeding it and the only one whose result is also paged and counted.
  it('lifts the gate through the org arm despite an uncastable id', async () => {
    const { lakes, total } = await dataLakeRepository.findPublicLakes(viewer, {
      orgGrantedLakes: { [GRANTING_ORG]: [JUNK_ID, publicOrgGatedId] },
    });
    expect(lakes.map(l => String(l.id))).toEqual([publicOrgGatedId]);
    expect(total).toBe(1);
  });

  it('keeps the gate up when no org-granted id is castable', async () => {
    const { lakes, total } = await dataLakeRepository.findPublicLakes(viewer, {
      orgGrantedLakes: { [GRANTING_ORG]: [JUNK_ID] },
    });
    expect(lakes).toEqual([]);
    expect(total).toBe(0);
  });
});

describe('findBySlugAmongIds', () => {
  it('resolves the slug when the candidate set also holds an uncastable id', async () => {
    const lake = await dataLakeRepository.findBySlugAmongIds('grant-only', [JUNK_ID, grantOnlyId]);
    expect(String(lake?.id)).toBe(grantOnlyId);
  });

  it('resolves to nothing when no candidate id is castable', async () => {
    expect(await dataLakeRepository.findBySlugAmongIds('grant-only', [JUNK_ID])).toBeNull();
  });
});
