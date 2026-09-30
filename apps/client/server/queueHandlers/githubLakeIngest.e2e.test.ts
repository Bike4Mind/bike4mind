import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  DataLakeModel,
  FabFile,
  OrgGitHubLakeConnection,
  User,
  dataLakeRepository,
  fabFileRepository,
  orgGitHubLakeConnectionRepository,
} from '@bike4mind/database';
import { DATALAKE_TAG_STRENGTH, FabFileSourceType, KnowledgeType } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  headSha: { value: 'commit-1' },
  blobSha: (content: string) => `blob-${Buffer.from(content).toString('base64')}`,
  getRecursiveTree: vi.fn(),
  upload: vi.fn(),
  storageDelete: vi.fn(),
  sendToQueue: vi.fn(),
  deleteInstallation: vi.fn(),
}));

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ upload: h.upload, delete: h.storageDelete }) }));
vi.mock('@server/queueHandlers/dataLakeBatchProgress', () => ({ finalizeBatchIfComplete: vi.fn() }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingByName: async (key: string) =>
    key === 'EnableDataLakes' || key === 'EnableDataLakeGitHub' ? true : undefined,
}));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/github/dataLake/lakeAppClient')>()),
  getGitHubLakeAppConfig: () => ({ appId: 'a', slug: 's', privateKey: 'k', clientId: 'c', clientSecret: 'x' }),
  getInstallationOctokit: async () => ({}),
  deleteInstallation: h.deleteInstallation,
  getRepository: async () => ({ fullName: 'acme/docs', defaultBranch: 'main' }),
  getBranchHeadSha: async () => h.headSha.value,
  getRecursiveTree: h.getRecursiveTree,
  getBlobBytes: async (_octokit: unknown, _repo: string, sha: string) => {
    const content = [...h.files.values()].find(c => h.blobSha(c) === sha);
    if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
    return Buffer.from(content);
  },
}));

import { dispatch } from './githubLakeIngest';
import { disconnectGitHubLakeConnection } from '@server/integrations/github/dataLake/githubLakeConnection';

let mongo: MongoMemoryReplSet;
const logger = {
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
} as never;
const run = (body: Record<string, unknown>) =>
  dispatch(
    { Records: [{ body: JSON.stringify(body) }] } as never,
    { getRemainingTimeInMillis: () => 600_000 } as never,
    logger
  );
const setRepo = (entries: [string, string][]) => {
  h.files.clear();
  for (const [path, content] of entries) h.files.set(path, content);
};

const connect = (lakeId: string, userId: string) =>
  orgGitHubLakeConnectionRepository.create({
    organizationId: 'org-gh-e2e',
    targetDataLakeId: lakeId,
    installationId: 111,
    accountLogin: 'acme',
    repositoryId: 222,
    repositoryFullName: 'acme/docs',
    connectedBy: userId,
    connectedAt: new Date(),
  });

async function seed() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const user = await User.create({ username: `gh-lake-e2e-${suffix}`, name: 'GitHub Lake E2E' });
  const lake = await DataLakeModel.create({
    name: `gh-lake-${suffix}`,
    slug: `gh-lake-${suffix}`,
    fileTagPrefix: `gh-${suffix}:`,
    datalakeTag: `datalake:gh-${suffix}`,
    createdByUserId: user.id,
    organizationId: 'org-gh-e2e',
    origin: 'connector-fed',
    status: 'active',
  });
  const connection = await connect(lake.id, user.id);
  return {
    userId: user.id as string,
    lakeId: lake.id as string,
    datalakeTag: lake.datalakeTag as string,
    connectionId: connection.id,
  };
}

beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri());
  await OrgGitHubLakeConnection.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(() => {
  h.headSha.value = 'commit-1';
  h.getRecursiveTree.mockImplementation(async () => ({
    truncated: false,
    entries: [...h.files].map(([path, content]) => ({
      path,
      mode: '100644',
      type: 'blob',
      sha: h.blobSha(content),
      size: Buffer.byteLength(content),
    })),
  }));
  h.upload.mockResolvedValue(undefined);
  h.storageDelete.mockResolvedValue(undefined);
  h.sendToQueue.mockResolvedValue(undefined);
  h.deleteInstallation.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    FabFile.deleteMany({}, { hardDelete: true }),
    DataLakeModel.deleteMany({}, { hardDelete: true }),
    OrgGitHubLakeConnection.deleteMany({}, { hardDelete: true }),
    User.deleteMany({}, { hardDelete: true }),
  ]);
});

describe('githubLakeIngest end to end', () => {
  it('first ingest creates the filtered files, every one stamped', async () => {
    const { lakeId, datalakeTag, connectionId } = await seed();
    setRepo([
      ['README.md', '# Docs\n'],
      ['src/index.ts', 'export const a = 1;\n'],
      ['logo.png', 'not text'],
      ['node_modules/pkg/index.js', 'vendored'],
    ]);

    await run({ connectionId });

    const live = await fabFileRepository.findByGitHubConnectionIdInDataLake(connectionId, datalakeTag);
    expect(live.map(f => f.githubPath).sort()).toEqual(['README.md', 'src/index.ts']);
    for (const f of live) {
      expect(f.githubConnectionId).toBe(connectionId);
      expect(f.githubBlobSha).toBe(h.blobSha(h.files.get(f.githubPath!)!));
      expect(f.sourceLakeId).toBe(lakeId);
      expect(f.sourceType).toBe(FabFileSourceType.GITHUB);
    }
    expect(live.find(f => f.githubPath === 'src/index.ts')?.mimeType).toBe('text/plain');
    expect(await orgGitHubLakeConnectionRepository.findById(connectionId)).toMatchObject({
      status: 'connected',
      lastSyncedCommitSha: 'commit-1',
      defaultBranch: 'main',
    });
  });

  it('a re-sync after edit, add and delete leaves the new content and deletes the old copies', async () => {
    const { datalakeTag, connectionId } = await seed();
    setRepo([
      ['README.md', '# Docs\n'],
      ['src/index.ts', 'export const a = 1;\n'],
    ]);
    await run({ connectionId });
    const before = await fabFileRepository.findByGitHubConnectionIdInDataLake(connectionId, datalakeTag);
    const oldReadme = before.find(f => f.githubPath === 'README.md')!;
    const oldIndex = before.find(f => f.githubPath === 'src/index.ts')!;

    setRepo([
      ['README.md', '# Docs v2\n'],
      ['docs/new.md', 'brand new\n'],
    ]);
    h.headSha.value = 'commit-2';
    await run({ connectionId, manual: true });

    const after = await fabFileRepository.findByGitHubConnectionIdInDataLake(connectionId, datalakeTag);
    expect(after.map(f => f.githubPath).sort()).toEqual(['README.md', 'docs/new.md']);
    expect(after.find(f => f.githubPath === 'README.md')?.githubBlobSha).toBe(h.blobSha('# Docs v2\n'));
    for (const f of after) expect(f.githubConnectionId).toBe(connectionId);
    for (const retired of [oldReadme, oldIndex]) {
      const row = await FabFile.findById(retired.id).setOptions({ includeDeleted: true });
      expect(row?.deletedAt).toBeTruthy();
      expect(h.storageDelete).toHaveBeenCalledWith(retired.filePath);
    }
    expect(await orgGitHubLakeConnectionRepository.findById(connectionId)).toMatchObject({
      lastSyncedCommitSha: 'commit-2',
    });
  });

  it('a non-manual re-sync with no new commit is a no-op', async () => {
    const { connectionId } = await seed();
    setRepo([['README.md', '# Docs\n']]);
    await run({ connectionId });
    const count = await FabFile.countDocuments({ githubConnectionId: connectionId });
    h.getRecursiveTree.mockClear();
    h.upload.mockClear();

    await run({ connectionId });

    expect(h.getRecursiveTree).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(await FabFile.countDocuments({ githubConnectionId: connectionId })).toBe(count);
  });

  it('retires a duplicate FabFile for a live path on the next sync', async () => {
    const { userId, lakeId, datalakeTag, connectionId } = await seed();
    setRepo([['README.md', '# Docs\n']]);
    await run({ connectionId });
    const [original] = await fabFileRepository.findByGitHubConnectionIdInDataLake(connectionId, datalakeTag);
    const duplicate = await FabFile.create({
      userId,
      fileName: 'README.md',
      mimeType: 'text/markdown',
      type: KnowledgeType.FILE,
      filePath: 'duplicate-key.md',
      fileSize: 7,
      status: 'complete',
      tags: [{ name: datalakeTag, strength: DATALAKE_TAG_STRENGTH }],
      sourceType: FabFileSourceType.GITHUB,
      githubConnectionId: connectionId,
      githubPath: 'README.md',
      githubBlobSha: original.githubBlobSha,
      sourceLakeId: lakeId,
    });

    await run({ connectionId, manual: true });

    const readmes = (await fabFileRepository.findByGitHubConnectionIdInDataLake(connectionId, datalakeTag)).filter(
      f => f.githubPath === 'README.md'
    );
    expect(readmes.map(f => f.id)).toEqual([duplicate.id]);
    const retired = await FabFile.findById(original.id).setOptions({ includeDeleted: true });
    expect(retired?.deletedAt).toBeTruthy();
  });

  it('disconnect purges the connection s files, so a reconnect re-sync leaves no orphaned copy', async () => {
    const { userId, lakeId, datalakeTag, connectionId } = await seed();
    setRepo([
      ['README.md', '# Docs\n'],
      ['src/index.ts', 'export const a = 1;\n'],
    ]);
    await run({ connectionId });
    expect(await FabFile.countDocuments({ githubConnectionId: connectionId })).toBe(2);

    const lake = await dataLakeRepository.findById(lakeId);
    const connection = await orgGitHubLakeConnectionRepository.findById(connectionId);
    await expect(disconnectGitHubLakeConnection(lake!, connection!, logger)).resolves.toEqual({
      installationRetained: false,
    });
    expect(await orgGitHubLakeConnectionRepository.findById(connectionId)).toBeNull();
    expect(
      await FabFile.countDocuments({ githubConnectionId: connectionId }).setOptions({ includeDeleted: true })
    ).toBe(0);

    // Delete upstream while disconnected: the race the purge closes is a file that vanishes in the gap,
    // which the reconnect's first sync can no longer see to retire.
    setRepo([['src/index.ts', 'export const a = 1;\n']]);
    h.headSha.value = 'commit-2';
    const { id: reconnectedId } = await connect(lakeId, userId);
    await run({ connectionId: reconnectedId });

    const live = await FabFile.find({ tags: { $elemMatch: { name: datalakeTag } }, archivedAt: null });
    expect(live.map(f => [f.githubPath, f.githubConnectionId])).toEqual([['src/index.ts', reconnectedId]]);
  });
});
