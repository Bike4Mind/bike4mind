import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';
import {
  DataLakeModel,
  FabFile,
  FabFileChunk,
  User,
  adminSettingsRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

// The mirror, repositories and lake bootstrap are real; provider credentials and embeddings are stubbed.
const { embed, getEffectiveLLMApiKeys } = vi.hoisted(() => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
  getEffectiveLLMApiKeys: vi.fn(async () => ({})),
}));
vi.mock('@bike4mind/scripts/help/ingestHelpDatalake', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/scripts/help/ingestHelpDatalake')>()),
  createHelpEmbedder: (model: string) => ({ embed, model }),
}));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: '' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { HELP_LAKE_BOOTSTRAP_MARKER, runHelpDatalakeIngest } from '@workers/cron/helpDatalakeIngest';
import { userRepository } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
let root: string;

const ADMIN = new mongoose.Types.ObjectId();
const LATER_ADMIN = new mongoose.Types.ObjectId();

const entry = (slug: string, accessLevel: 'public' | 'admin' = 'public') => ({
  slug,
  title: slug,
  description: '',
  category: 'features',
  sidebarPosition: 1,
  tags: [],
  headings: [],
  filePath: `${slug}.md`,
  accessLevel,
});

const selfHostRun = () =>
  runHelpDatalakeIngest({ corpusRoot: root, bootstrapOwnerId: () => userRepository.findOldestActiveAdminId() });

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri());
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
  getEffectiveLLMApiKeys.mockReset();
  getEffectiveLLMApiKeys.mockResolvedValue({});
  embed.mockReset();
  embed.mockResolvedValue([0.1, 0.2, 0.3]);
  vi.spyOn(adminSettingsRepository, 'getSettingsValue').mockResolvedValue('text-embedding-3-small');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-corpus-'));
  const entries = [entry('features/chat'), entry('features/files'), entry('admin/users', 'admin')];
  fs.writeFileSync(path.join(root, 'help-index.json'), JSON.stringify({ entries }));
  for (const { slug } of entries) {
    const file = path.join(root, 'docs', `${slug}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${slug}\n\nBody of ${slug}.\n`);
  }
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('self-host helpDatalakeIngest', () => {
  it('bootstraps a fresh install under its oldest admin, then re-ingests as a no-op', async () => {
    await User.collection.insertMany([
      { _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true },
      { _id: LATER_ADMIN, username: 'later', email: 'later@example.com', isAdmin: true },
    ]);

    const first = await selfHostRun();
    expect(first).toMatchObject({ created: 2 });
    const lake = await DataLakeModel.findOne({ slug: 'system-help' }).lean();
    expect(String(lake?.createdByUserId)).toBe(String(ADMIN));
    const files = await FabFile.countDocuments({});
    const chunks = await FabFileChunk.countDocuments({});
    expect(files).toBe(2);
    const embedsAfterFirst = embed.mock.calls.length;
    expect(embedsAfterFirst).toBeGreaterThan(0);

    const second = await selfHostRun();
    expect(second).toMatchObject({ created: 0, removed: 0, unchanged: 2 });
    expect(embed.mock.calls.length).toBe(embedsAfterFirst);
    expect(await FabFile.countDocuments({})).toBe(files);
    expect(await FabFileChunk.countDocuments({})).toBe(chunks);
    expect(await DataLakeModel.countDocuments({})).toBe(1);
  });

  it('waits for an active admin instead of creating a lake nobody owns', async () => {
    await User.collection.insertMany([
      { _id: ADMIN, username: 'user', email: 'user@example.com' },
      { username: 'banned', email: 'banned@example.com', isAdmin: true, isBanned: true },
      { username: 'gone', email: 'gone@example.com', isAdmin: true, deletedAt: new Date() },
    ]);

    expect(await selfHostRun()).toEqual({ skipped: 'no-owner' });
    expect(await DataLakeModel.countDocuments({})).toBe(0);
  });

  it('does not revive a help lake an admin deleted', async () => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });
    await selfHostRun();
    await DataLakeModel.updateOne({ slug: 'system-help' }, { $set: { status: 'deleted' } });

    expect(await selfHostRun()).toEqual({ skipped: 'lake-missing' });
    expect((await DataLakeModel.findOne({ slug: 'system-help' }).lean())?.status).toBe('deleted');
  });

  it('does not re-bootstrap a help lake an admin purged', async () => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });
    expect(await selfHostRun()).toMatchObject({ created: 2 });
    // What cleanupDeletedDataLake ends with: the lake row is hard-deleted.
    await DataLakeModel.collection.deleteMany({ slug: 'system-help' });
    const embedsBefore = embed.mock.calls.length;

    expect(await selfHostRun()).toEqual({ skipped: 'lake-missing' });
    expect(await DataLakeModel.countDocuments({})).toBe(0);
    expect(embed.mock.calls.length).toBe(embedsBefore);
  });

  it('does not re-bootstrap a purged lake that the worker did not create', async () => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });
    // Bootstrapped by hand (help:ingest-datalake) before this worker ever ran.
    await selfHostRun();
    await mongoose.model('AdminSettings').collection.deleteMany({});
    await selfHostRun();
    await DataLakeModel.collection.deleteMany({ slug: 'system-help' });

    expect(await selfHostRun()).toEqual({ skipped: 'lake-missing' });
  });

  it('rolls back the bootstrap marker when lake creation fails and retries successfully', async () => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });
    const creationError = new Error('lake creation failed');
    vi.spyOn(dataLakeRepository, 'create').mockRejectedValueOnce(creationError);

    await expect(selfHostRun()).rejects.toThrow(creationError);
    expect(await DataLakeModel.countDocuments({})).toBe(0);
    expect(await mongoose.model('AdminSettings').countDocuments({ settingName: HELP_LAKE_BOOTSTRAP_MARKER })).toBe(0);

    expect(await selfHostRun()).toMatchObject({ created: 2 });
    expect(await DataLakeModel.countDocuments({})).toBe(1);
  });

  it('keeps the committed lake and marker after an embedding failure so the next run can recover', async () => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });
    embed.mockRejectedValueOnce(new Error('embedding unavailable'));

    await expect(selfHostRun()).rejects.toThrow('embedding unavailable');
    expect(await DataLakeModel.countDocuments({})).toBe(1);
    expect(await mongoose.model('AdminSettings').countDocuments({ settingName: HELP_LAKE_BOOTSTRAP_MARKER })).toBe(1);

    expect(await selfHostRun()).toMatchObject({ created: 2 });
    expect(await FabFile.countDocuments({})).toBe(2);
  });

  it('creates a single help lake when two workers bootstrap concurrently', async () => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });

    const results = await Promise.all([selfHostRun(), selfHostRun()]);

    expect(results).toContainEqual(expect.objectContaining({ created: 2 }));
    expect(await DataLakeModel.countDocuments({})).toBe(1);
    expect(await mongoose.model('AdminSettings').countDocuments({ settingName: HELP_LAKE_BOOTSTRAP_MARKER })).toBe(1);
    expect(await FabFile.countDocuments({})).toBe(2);
  });

  it.each(['deleted', 'purged'] as const)('does not recreate a lake %s during credential lookup', async status => {
    await User.collection.insertOne({ _id: ADMIN, username: 'admin', email: 'admin@example.com', isAdmin: true });
    await selfHostRun();
    embed.mockClear();
    getEffectiveLLMApiKeys.mockImplementationOnce(async () => {
      if (status === 'purged') await DataLakeModel.collection.deleteMany({ slug: 'system-help' });
      else await DataLakeModel.updateOne({ slug: 'system-help' }, { $set: { status: 'deleted' } });
      return {};
    });

    await expect(selfHostRun()).rejects.toThrow('refusing unattended reactivation');

    expect(embed).not.toHaveBeenCalled();
    expect(await DataLakeModel.countDocuments({ slug: 'system-help', status: 'active' })).toBe(0);
    expect(await DataLakeModel.countDocuments({})).toBe(status === 'purged' ? 0 : 1);
  });
});
