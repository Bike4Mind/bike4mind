import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { IUserDocument } from '@bike4mind/common';
// createMongoReplSet is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  User,
  Organization,
  DataLakeModel,
  DataLakeAccessGrantModel,
  FabFile,
  LakeConfigChangeEventModel,
  LakeMembershipChangeEventModel,
  adminSettingsRepository,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  organizationRepository,
  scopedSettingsRepository,
  userRepository,
} from '@bike4mind/database';
import { buildSharedTools } from '@bike4mind/services/llm';
import { lakeWriteToolDb } from '@server/dataLakes/lakeWriteToolDb';
import { makeToolBuilderDeps, makeToolBuilderCallbacks } from './toolBuilderDeps.fixture';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The lake write tools on the agent host, run against the REAL repositories and audit sinks the
 * executor's toolDeps spread (`lakeWriteToolDb`). `processExecution` has no harness, so the two
 * toolDeps blocks themselves are pinned by the source check below, the same way
 * checkToolAvailabilityWired.test.ts pins the availability wiring.
 */
describe('agentExecutor toolDeps wiring', () => {
  const source = readFileSync(join(__dirname, 'agentExecutor.ts'), 'utf8');

  it('spreads the lake write adapters into both the main and the subagent toolDeps', () => {
    expect(source.match(/\.\.\.lakeWriteToolDb,/g)).toHaveLength(2);
  });

  it('stamps the run organization on both toolDeps', () => {
    expect(source).toMatch(/const toolDeps: ToolBuilderDeps = \{[^}]*organizationId: execution\.organizationId,/);
    expect(source).toMatch(/const toolDeps: ToolBuilderDeps = \{[^}]*organizationId: child\.organizationId,/);
  });
});

let replSet: MongoMemoryReplSet;
const MODELS = [
  User,
  Organization,
  DataLakeModel,
  DataLakeAccessGrantModel,
  FabFile,
  LakeConfigChangeEventModel,
  LakeMembershipChangeEventModel,
] as const;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  await settleAutoIndexBuilds(mongoose);
  await Promise.all(MODELS.map(m => m.init()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  await Promise.all(MODELS.map(m => (m as typeof User).deleteMany({})));
});

const suffix = () => Math.random().toString(36).slice(2, 10);

// Only the platform flag is overridden; every other read goes to the real repository.
const adminSettings = Object.assign(Object.create(adminSettingsRepository), {
  getSettingsValue: async (name: string) =>
    name === 'EnableDataLakes' ? true : adminSettingsRepository.getSettingsValue(name as never),
});

const storage = { upload: vi.fn().mockResolvedValue(undefined), getSignedUrl: vi.fn().mockResolvedValue('') };

const createUser = async (name: string) => {
  const s = suffix();
  return (await User.create({
    name,
    username: `${name}-${s}`,
    email: `${name}-${s}@example.com`,
    password: null,
    hasUsablePassword: false,
  })) as unknown as IUserDocument;
};

const lakeTools = (user: IUserDocument, organizationId?: string) => {
  const deps = makeToolBuilderDeps({
    userId: user.id,
    user,
    organizationId,
    storage: storage as never,
    db: {
      ...makeToolBuilderDeps().db,
      adminSettings,
      fabfiles: fabFileRepository,
      users: userRepository,
      dataLakes: dataLakeRepository,
      dataLakeAccessGrants: dataLakeAccessGrantRepository,
      organizations: organizationRepository,
      scopedSettings: scopedSettingsRepository,
      ...lakeWriteToolDb,
    } as never,
  });
  const tools = buildSharedTools(deps, makeToolBuilderCallbacks(), {
    enabledTools: ['create_data_lake', 'save_content_to_data_lake'],
  })!;
  const call = (name: string, args: unknown) => tools.find(t => t.toolSchema.name === name)!.toolFn(args);
  return {
    create: (name: string) => call('create_data_lake', { name }) as Promise<string>,
    save: (dataLakeId: string) =>
      call('save_content_to_data_lake', {
        dataLakeId,
        content: 'QA paragraph',
        fileName: 'qa-note.md',
      }) as Promise<string>,
  };
};

const lakeIdFrom = (reply: string) => /\(id: ([a-f0-9]{24})/.exec(reply)?.[1];

describe('agent lake write tools on real repositories', () => {
  it('creates the lake in the run organization and records its history row', async () => {
    const user = await createUser('owner');
    const org = await Organization.create({ name: `Org ${suffix()}`, userId: user.id });

    const reply = await lakeTools(user, org.id).create('QA Org Notes');
    expect(reply).toContain('shared with the active organization');

    const lake = await DataLakeModel.findById(lakeIdFrom(reply)).lean();
    expect(String(lake?.organizationId)).toBe(org.id);
    expect(await LakeConfigChangeEventModel.countDocuments({ dataLakeId: lake?._id.toString() })).toBeGreaterThan(0);
  });

  it('creates a personal lake when the run has no organization', async () => {
    const user = await createUser('solo');
    const reply = await lakeTools(user).create('QA Notes');
    expect(reply).toContain('personal');
    const lake = await DataLakeModel.findById(lakeIdFrom(reply)).lean();
    expect(lake?.organizationId ?? null).toBeNull();
  });

  it('refuses an organization the user is not a member of and creates nothing', async () => {
    const [user, stranger] = await Promise.all([createUser('outsider'), createUser('stranger')]);
    const org = await Organization.create({ name: `Org ${suffix()}`, userId: stranger.id });

    const reply = await lakeTools(user, org.id).create('Not Mine');
    expect(reply).toContain('could not be created in the active organization');
    expect(await DataLakeModel.countDocuments({})).toBe(0);
  });

  it('saves the file into a created lake and records the membership audit row', async () => {
    const user = await createUser('saver');
    const tools = lakeTools(user);
    const lakeId = lakeIdFrom(await tools.create('QA Save Notes'))!;

    const reply = await tools.save(lakeId);
    expect(reply).not.toMatch(/not available on this surface/);
    const file = await FabFile.findOne({ fileName: 'qa-note.md' }).lean();
    expect(file).not.toBeNull();
    expect(
      await LakeMembershipChangeEventModel.countDocuments({ dataLakeId: lakeId, fabFileId: file!._id.toString() })
    ).toBeGreaterThan(0);
  });
});
