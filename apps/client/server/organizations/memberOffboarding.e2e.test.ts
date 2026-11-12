import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { IUserDocument } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  Project,
  Session,
  agentRepository,
  artifactRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
} from '@bike4mind/database';
// Source, not the @bike4mind/services dist, so a stale local build cannot report green here.
import { getMemberOffboardingInventory } from '../../../../b4m-core/services/src/organizationService/getMemberOffboardingInventory';
import { reassignMemberContent } from '../../../../b4m-core/services/src/organizationService/reassignMemberContent';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Drives the offboarding inventory and transfer against real models: the unit tests mock the
 * repositories, so neither id casting nor ProjectModel's per-owner unique name index is exercised
 * there.
 */

const ORG = 'org-1';
const GROUP = 'group-1';
const MEMBER = 'member-1';
const RECIPIENT = 'member-2';
const owner = { id: 'owner-1', isAdmin: false } as IUserDocument;

const organization = {
  id: ORG,
  userId: owner.id,
  name: 'Acme',
  adminUserIds: [] as string[],
  users: [
    { userId: MEMBER, permissions: ['read'] },
    { userId: RECIPIENT, permissions: ['read'] },
  ],
};

const db = {
  organizations: { findById: async () => organization },
  groups: { findByOrganization: async () => [{ id: GROUP }] },
  users: { findById: async (id: string) => ({ id, isBanned: false }) },
  fabFiles: fabFileRepository,
  artifacts: artifactRepository,
  projects: projectRepository,
  sessions: sessionRepository,
  agents: agentRepository,
  userApiKeys: { count: async () => 0 },
};

const groupShare = [{ groupId: GROUP, permissions: ['read'] }];

async function seedProject(userId: string, name: string, extra: Record<string, unknown> = {}) {
  const { insertedId } = await Project.collection.insertOne({
    userId,
    name,
    deletedAt: null,
    users: [],
    groups: [],
    sessionIds: [],
    fileIds: [],
    ...extra,
  });
  return String(insertedId);
}

async function seedNotebook(name: string, extra: Record<string, unknown> = {}) {
  const { insertedId } = await Session.collection.insertOne({ userId: MEMBER, name, deletedAt: null, ...extra });
  return String(insertedId);
}

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Project.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await Promise.all([Project.collection.deleteMany({}), Session.collection.deleteMany({})]);
});

describe('member offboarding against real models', () => {
  it('lists content when an in-scope project holds a session id that is not an ObjectId', async () => {
    const shared = await seedNotebook('Shared notes', { groups: groupShare });
    await seedProject(MEMBER, 'Launch', { groups: groupShare, sessionIds: [shared, 'not-an-object-id'] });

    const inventory = await getMemberOffboardingInventory(owner, { id: ORG, userId: MEMBER }, { db });

    expect(inventory.projects.count).toBe(1);
    expect(inventory.notebooks.sample.map(entry => entry.id)).toEqual([shared]);
  });

  it('moves a project whose name the recipient already uses under a suffixed name', async () => {
    await seedProject(RECIPIENT, 'Roadmap');
    const moving = await seedProject(MEMBER, 'Roadmap', { groups: groupShare });

    const counts = await reassignMemberContent(owner, { id: ORG, userId: MEMBER, reassignTo: RECIPIENT }, { db });

    expect(counts.projects).toBe(1);
    const moved = await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(moving) });
    expect(moved).toMatchObject({ userId: RECIPIENT, name: 'Roadmap (transferred)' });
  });

  it('leaves a notebook inside a group-shared project with the member when it has no group share of its own', async () => {
    const privateNotebook = await seedNotebook('Private');
    await seedProject(MEMBER, 'Launch', { groups: groupShare, sessionIds: [privateNotebook] });

    const counts = await reassignMemberContent(owner, { id: ORG, userId: MEMBER, reassignTo: RECIPIENT }, { db });

    expect(counts).toMatchObject({ projects: 1, notebooks: 0 });
    const notebook = await Session.collection.findOne({ _id: new mongoose.Types.ObjectId(privateNotebook) });
    expect(notebook?.userId).toBe(MEMBER);
  });
});
