import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Session, adminAuditLogRepository, fabFileRepository, sessionRepository } from '@bike4mind/database';
import { ConcurrencyConflictError } from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({
  deleteGenerated: vi.fn(),
  deletePrefix: vi.fn(),
  deleteFile: vi.fn(),
  sendCompleteEmail: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.deleteGenerated, deletePermanently: effects.deleteGenerated }),
  getPublishedArtifactsStorage: () => ({
    deletePrefix: effects.deletePrefix,
    deletePrefixPermanently: effects.deletePrefix,
  }),
  getFilesStorage: () => ({
    delete: effects.deleteFile,
    deletePermanently: effects.deleteFile,
    deletePrefix: effects.deletePrefix,
    deletePrefixPermanently: effects.deletePrefix,
  }),
  getAppFilesStorage: () => ({ delete: effects.deleteFile, deletePermanently: effects.deleteFile }),
}));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({ purgeUserPublishedArtifacts: vi.fn() }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: vi.fn() }));
vi.mock('@server/auth/signupNetworkLimits', () => ({ retainDeletedSignupTraces: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionCompleteEmail: effects.sendCompleteEmail }));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: vi.fn(async () => ({ canceled: [], failed: [] })),
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));

import { purgeAccountContent } from './purgeAccountContent';
import { completeAccountDeletion } from './completeAccountDeletion';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
const ownerId = new mongoose.Types.ObjectId().toString();
const otherOwnerId = new mongoose.Types.ObjectId().toString();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const assertLease = vi.fn(async () => undefined);
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.deleteGenerated.mockResolvedValue(undefined);
  effects.deletePrefix.mockResolvedValue(undefined);
  effects.deleteFile.mockResolvedValue(undefined);
  effects.sendCompleteEmail.mockResolvedValue(undefined);
  assertLease.mockResolvedValue(undefined);
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

describe('permanent personal-content purge', () => {
  it('retains the real account and purge marker after object failure, then removes content and User before emailing completion', async () => {
    const notebookId = new mongoose.Types.ObjectId();
    const fileId = new mongoose.Types.ObjectId();
    const storedObjects = new Set(['private-upload', 'private-generated']);
    const completionSnapshots: { remainingRows: number[]; remainingObjects: number }[] = [];
    await collection('User').insertOne({
      _id: new mongoose.Types.ObjectId(ownerId),
      email: 'purge@example.test',
      createdAt: new Date('2025-01-01'),
      deletion: { requestedAt: new Date('2026-01-01'), scheduledFor: new Date('2026-01-15'), source: 'self' },
    });
    await collection(Session.modelName).insertOne({ _id: notebookId, userId: ownerId });
    await collection('Quest').insertOne({ sessionId: String(notebookId), images: ['private-generated'] });
    await collection('FabFile').insertOne({
      _id: fileId,
      userId: ownerId,
      filePath: 'private-upload',
      fileName: 'private.txt',
      tags: [],
      moderationStatus: 'clean',
    });
    await collection('FabFileChunk').insertOne({ fabFileId: String(fileId), content: 'private extracted text' });
    effects.deleteFile.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(completeAccountDeletion(ownerId, { logger })).rejects.toThrow('storage unavailable');
    expect(await collection('User').findOne({ _id: new mongoose.Types.ObjectId(ownerId) })).toMatchObject({
      deletion: { purgeStartedAt: expect.any(Date) },
    });
    expect(await collection('FabFile').findOne({ _id: fileId })).not.toBeNull();
    expect(effects.sendCompleteEmail).not.toHaveBeenCalled();
    effects.deleteFile.mockImplementation(async (key: string) => {
      storedObjects.delete(key);
    });
    effects.deleteGenerated.mockImplementation(async (key: string) => {
      storedObjects.delete(key);
    });
    effects.sendCompleteEmail.mockImplementation(async () => {
      completionSnapshots.push({
        remainingRows: await Promise.all([
          collection('User').countDocuments({ _id: new mongoose.Types.ObjectId(ownerId) }),
          collection(Session.modelName).countDocuments({ _id: notebookId }),
          collection('Quest').countDocuments({ sessionId: String(notebookId) }),
          collection('FabFile').countDocuments({ _id: fileId }),
          collection('FabFileChunk').countDocuments({ fabFileId: String(fileId) }),
        ]),
        remainingObjects: storedObjects.size,
      });
    });
    await expect(completeAccountDeletion(ownerId, { logger })).resolves.toEqual({ deleted: true });
    await expect(completeAccountDeletion(ownerId, { logger })).resolves.toEqual({
      deleted: false,
      reason: 'not_found',
    });
    expect(effects.sendCompleteEmail).toHaveBeenCalledExactlyOnceWith('purge@example.test');
    expect(completionSnapshots).toEqual([{ remainingRows: [0, 0, 0, 0, 0], remainingObjects: 0 }]);
  });
  it('hard-deletes notebooks, messages and personal content including tombstones, preserving other owners and org content', async () => {
    const notebookId = new mongoose.Types.ObjectId();
    const otherNotebookId = new mongoose.Types.ObjectId();
    const personalOrganizationId = new mongoose.Types.ObjectId();
    await collection('Organization').insertOne({ _id: personalOrganizationId, userId: ownerId, personal: true });
    await collection(Session.modelName).insertMany([
      { _id: notebookId, userId: ownerId, deletedAt: new Date() },
      { _id: otherNotebookId, userId: otherOwnerId, users: [{ userId: ownerId }] },
    ]);
    await collection('Quest').insertMany([
      { sessionId: String(notebookId), userId: ownerId, prompt: 'private prompt', images: ['private-image'] },
      { sessionId: String(otherNotebookId), userId: otherOwnerId, prompt: 'independent copy' },
    ]);
    await collection('Project').insertMany([
      { userId: ownerId, name: 'private project', deletedAt: new Date() },
      { userId: ownerId, organizationId: String(personalOrganizationId), name: 'personal workspace project' },
      { userId: ownerId, organizationId: 'org-1', name: 'org project' },
      { userId: otherOwnerId, name: 'other project', users: [{ userId: ownerId }] },
    ]);
    await collection('Artifact').insertOne({ id: 'personal-artifact', userId: ownerId });
    await collection('ArtifactContent').insertOne({ artifactId: 'personal-artifact', content: 'private content' });
    await collection('ArtifactVersion').insertOne({ artifactId: 'personal-artifact', content: 'old private content' });
    await collection('AuthSession').insertOne({ userId: ownerId });
    await collection('CounterLog').insertOne({ userId: ownerId, metadata: { title: 'private title' } });
    await collection('UsageEvent').insertMany([
      { userId: ownerId, ownerType: 'User', ownerId, requestId: 'personal-usage' },
      {
        userId: ownerId,
        ownerType: 'Organization',
        ownerId: String(personalOrganizationId),
        requestId: 'personal-workspace-usage',
      },
      {
        userId: ownerId,
        ownerType: 'Organization',
        ownerId: 'org-1',
        requestId: 'org-usage',
        sessionId: String(notebookId),
        dataLakeId: 'private-lake',
        apiKeyId: 'private-key',
        inputTokens: 123,
      },
    ]);
    for (const modelName of ['GenerationJob', 'Activity']) {
      await collection(modelName).insertMany([
        { ownerType: 'User', ownerId, payload: { prompt: 'personal job' } },
        {
          ownerType: 'Organization',
          ownerId: String(personalOrganizationId),
          payload: { prompt: 'personal workspace job' },
        },
        { ownerType: 'Organization', ownerId: 'org-1', payload: { prompt: 'organization job' } },
      ]);
    }
    await collection('Annotation').insertOne({
      authorId: ownerId,
      publicId: 'another-owner-page',
      body: 'annotation',
      deletedAt: null,
    });
    await collection('UserApiKeyAuditLog').insertOne({
      actorUserId: ownerId,
      action: 'revoke',
      expiresAt: new Date('2027-01-01'),
    });
    for (const modelName of [
      'UserActivityCounter',
      'UserUsagePatternSignals',
      'AdminUserNote',
      'AdminUserNoteRevision',
    ]) {
      await collection(modelName).insertOne({ userId: ownerId, body: 'private account note' });
    }

    await purgeAccountContent(ownerId, { logger, assertLease });

    expect(await collection(Session.modelName).findOne({ _id: notebookId })).toBeNull();
    expect(await collection('Quest').countDocuments({ sessionId: String(notebookId) })).toBe(0);
    expect(effects.deleteGenerated).toHaveBeenCalledWith('private-image');
    expect(await collection('Artifact').countDocuments({ userId: ownerId })).toBe(0);
    expect(await collection('ArtifactContent').countDocuments({ artifactId: 'personal-artifact' })).toBe(0);
    expect(await collection('ArtifactVersion').countDocuments({ artifactId: 'personal-artifact' })).toBe(0);
    expect(await collection('AuthSession').countDocuments({ userId: ownerId })).toBe(0);
    expect(await collection('CounterLog').countDocuments({ userId: ownerId })).toBe(0);
    expect(await collection('UsageEvent').countDocuments({ ownerType: 'User', ownerId })).toBe(0);
    expect(await collection('UsageEvent').countDocuments({ ownerId: String(personalOrganizationId) })).toBe(0);
    const organizationUsage = await collection('UsageEvent').findOne({ ownerId: 'org-1' });
    expect(organizationUsage).toMatchObject({ userId: 'deleted-account', ownerType: 'Organization', inputTokens: 123 });
    expect(organizationUsage?.requestId).not.toBe('org-usage');
    for (const field of ['sessionId', 'dataLakeId', 'apiKeyId']) expect(organizationUsage).not.toHaveProperty(field);
    for (const modelName of ['GenerationJob', 'Activity']) {
      expect(await collection(modelName).countDocuments({ ownerId })).toBe(0);
      expect(await collection(modelName).countDocuments({ ownerId: String(personalOrganizationId) })).toBe(0);
      expect(await collection(modelName).countDocuments({ ownerId: 'org-1' })).toBe(1);
    }
    expect(await collection('Annotation').findOne({ authorId: ownerId })).toMatchObject({
      deletedAt: expect.any(Date),
    });
    expect(await collection('UserApiKeyAuditLog').countDocuments({ actorUserId: ownerId })).toBe(1);
    for (const modelName of [
      'UserActivityCounter',
      'UserUsagePatternSignals',
      'AdminUserNote',
      'AdminUserNoteRevision',
    ]) {
      expect(await collection(modelName).countDocuments({ userId: ownerId })).toBe(0);
    }
    expect(await collection('Project').countDocuments({ userId: ownerId, organizationId: null })).toBe(0);
    expect(await collection('Project').countDocuments({ organizationId: String(personalOrganizationId) })).toBe(0);
    expect(await collection('Project').findOne({ organizationId: 'org-1' })).not.toBeNull();
    expect(await collection(Session.modelName).findOne({ _id: otherNotebookId })).toMatchObject({ users: [] });
    expect(await collection('Quest').findOne({ sessionId: String(otherNotebookId) })).not.toBeNull();
    expect(
      await collection('MemoryPrincipalKey').findOne({ principalKind: 'user', principalId: ownerId })
    ).toMatchObject({ destroyedAt: expect.any(Date) });
    expect(
      await collection('MemoryPrincipalKey').findOne({
        principalKind: 'user',
        principalId: ownerId,
        dek: { $exists: true },
      })
    ).toBeNull();
  });

  it('rejects stale grant writes after removing a deleted project from surviving documents', async () => {
    const projectId = new mongoose.Types.ObjectId();
    const fileId = new mongoose.Types.ObjectId();
    const notebookId = new mongoose.Types.ObjectId();
    const users = [{ userId: otherOwnerId, projectId: String(projectId), accessType: ['read'] }];
    await collection('Project').insertOne({ _id: projectId, userId: ownerId });
    await collection('FabFile').insertOne({ _id: fileId, userId: otherOwnerId, users, __v: 0 });
    await collection(Session.modelName).insertOne({ _id: notebookId, userId: otherOwnerId, users, __v: 0 });
    const staleFile = await fabFileRepository.findById(String(fileId));
    const staleNotebook = await sessionRepository.findById(String(notebookId));
    if (!staleFile || !staleNotebook) throw new Error('Expected surviving document fixtures');

    await purgeAccountContent(ownerId, { logger, assertLease });

    const staleFileWrite = { id: staleFile.id, users: staleFile.users, __v: 0 };
    await expect(fabFileRepository.updateGuarded(staleFileWrite, { includeDeleted: true })).rejects.toBeInstanceOf(
      ConcurrencyConflictError
    );
    const staleNotebookWrite = { id: staleNotebook.id, users: staleNotebook.users, __v: 0 };
    await expect(sessionRepository.updateGuarded(staleNotebookWrite, { includeDeleted: true })).rejects.toBeInstanceOf(
      ConcurrencyConflictError
    );
    expect(await collection('FabFile').findOne({ _id: fileId })).toMatchObject({ users: [], __v: 1 });
    expect(await collection(Session.modelName).findOne({ _id: notebookId })).toMatchObject({ users: [], __v: 1 });
  });

  it('rolls back account and personal workspace deletion after an audit failure, then retries once', async () => {
    const personalOrganizationId = new mongoose.Types.ObjectId();
    await collection('User').insertOne({
      _id: new mongoose.Types.ObjectId(ownerId),
      email: 'audit-retry@example.test',
      createdAt: new Date('2025-01-01'),
      deletion: { requestedAt: new Date('2026-01-01'), scheduledFor: new Date('2026-01-15'), source: 'self' },
    });
    await collection('Organization').insertOne({ _id: personalOrganizationId, userId: ownerId, personal: true });
    const append = vi.spyOn(adminAuditLogRepository, 'append').mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(completeAccountDeletion(ownerId, { logger })).rejects.toThrow('audit unavailable');
    expect(await collection('User').findOne({ _id: new mongoose.Types.ObjectId(ownerId) })).toMatchObject({
      deletion: { purgeStartedAt: expect.any(Date) },
    });
    expect(await collection('Organization').findOne({ _id: personalOrganizationId })).not.toBeNull();
    expect(await collection('AdminAuditLog').countDocuments({ 'target.id': ownerId })).toBe(0);
    expect(effects.sendCompleteEmail).not.toHaveBeenCalled();

    await expect(completeAccountDeletion(ownerId, { logger })).resolves.toEqual({ deleted: true });
    expect(await collection('User').findOne({ _id: new mongoose.Types.ObjectId(ownerId) })).toBeNull();
    expect(await collection('Organization').findOne({ _id: personalOrganizationId })).toBeNull();
    expect(await collection('AdminAuditLog').countDocuments({ 'target.id': ownerId })).toBe(1);
    expect(append).toHaveBeenCalledTimes(2);
    expect(effects.sendCompleteEmail).toHaveBeenCalledExactlyOnceWith('audit-retry@example.test');
  });

  it('removes provider keys, project-minted grants and Slack selections of removed agents', async () => {
    const projectId = new mongoose.Types.ObjectId();
    const otherProjectId = new mongoose.Types.ObjectId();
    const orgFileId = new mongoose.Types.ObjectId();
    const orgNotebookId = new mongoose.Types.ObjectId();
    const agentId = new mongoose.Types.ObjectId();
    const orgAgentId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId().toString();
    await collection('ApiKey').insertMany([
      { userId: ownerId, type: 'openai', apiKey: 'ciphertext', deletedAt: new Date() },
      { userId: otherOwnerId, type: 'openai', apiKey: 'other ciphertext' },
    ]);
    await collection('Project').insertMany([
      { _id: projectId, userId: ownerId, name: 'shared project', users: [{ userId: memberId }] },
      { _id: otherProjectId, userId: otherOwnerId, name: 'other project' },
    ]);
    const grants = [
      { userId: memberId, projectId: String(projectId) },
      { userId: memberId, projectId: String(otherProjectId) },
      { userId: memberId },
    ];
    await collection('FabFile').insertOne({
      _id: orgFileId,
      userId: otherOwnerId,
      organizationId: 'org-1',
      users: grants,
    });
    await collection(Session.modelName).insertOne({
      _id: orgNotebookId,
      userId: otherOwnerId,
      organizationId: 'org-1',
      users: grants,
    });
    await collection('Agent').insertMany([
      { _id: agentId, userId: ownerId, name: 'personal agent', deletedAt: new Date() },
      { _id: orgAgentId, userId: ownerId, organizationId: 'org-1', name: 'org agent' },
    ]);
    await collection('User').insertMany([
      { email: 'a@example.test', slackSettings: { customAgentId: String(agentId) } },
      { email: 'b@example.test', slackSettings: { customAgentId: String(orgAgentId) } },
    ]);

    await purgeAccountContent(ownerId, { logger, assertLease });
    await purgeAccountContent(ownerId, { logger, assertLease });

    expect(await collection('ApiKey').countDocuments({ userId: ownerId })).toBe(0);
    expect(await collection('ApiKey').countDocuments({ userId: otherOwnerId })).toBe(1);
    expect(await collection('Project').findOne({ _id: projectId })).toBeNull();
    const survivingGrants = [{ userId: memberId, projectId: String(otherProjectId) }, { userId: memberId }];
    expect(await collection('FabFile').findOne({ _id: orgFileId })).toMatchObject({ users: survivingGrants });
    expect(await collection(Session.modelName).findOne({ _id: orgNotebookId })).toMatchObject({
      users: survivingGrants,
    });
    expect(await collection('Agent').findOne({ _id: agentId })).toBeNull();
    expect(await collection('Agent').findOne({ _id: orgAgentId })).not.toBeNull();
    expect(await collection('User').findOne({ email: 'a@example.test' })).toMatchObject({ slackSettings: {} });
    expect(await collection('User').findOne({ email: 'b@example.test' })).toMatchObject({
      slackSettings: { customAgentId: String(orgAgentId) },
    });
  });

  it('keeps the notebook and messages discoverable after storage failure, then resumes idempotently', async () => {
    const notebookId = new mongoose.Types.ObjectId();
    await collection(Session.modelName).insertOne({ _id: notebookId, userId: ownerId });
    await collection('Quest').insertOne({ sessionId: String(notebookId), images: ['retry-image'] });
    effects.deleteGenerated.mockRejectedValueOnce(new Error('object store unavailable'));

    await expect(purgeAccountContent(ownerId, { logger, assertLease })).rejects.toThrow('object store unavailable');
    expect(await collection(Session.modelName).findOne({ _id: notebookId })).not.toBeNull();
    expect(await collection('Quest').findOne({ sessionId: String(notebookId) })).not.toBeNull();

    await purgeAccountContent(ownerId, { logger, assertLease });
    await purgeAccountContent(ownerId, { logger, assertLease });
    expect(await collection(Session.modelName).findOne({ _id: notebookId })).toBeNull();
    expect(await collection('Quest').findOne({ sessionId: String(notebookId) })).toBeNull();
    expect(effects.deleteGenerated).toHaveBeenCalledTimes(2);
  });

  it('preserves generated bytes referenced by another owner and refuses an expired purge lease', async () => {
    const notebookId = new mongoose.Types.ObjectId();
    const survivingId = new mongoose.Types.ObjectId();
    await collection(Session.modelName).insertMany([
      { _id: notebookId, userId: ownerId },
      { _id: survivingId, userId: otherOwnerId },
    ]);
    await collection('Quest').insertMany([
      { sessionId: String(notebookId), images: ['shared-image'] },
      { sessionId: String(survivingId), images: ['shared-image'] },
    ]);
    assertLease.mockRejectedValueOnce(new Error('lease lost'));
    await expect(purgeAccountContent(ownerId, { logger, assertLease })).rejects.toThrow('lease lost');
    expect(await collection(Session.modelName).findOne({ _id: notebookId })).not.toBeNull();
    await purgeAccountContent(ownerId, { logger, assertLease });
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    expect(await collection('Quest').findOne({ sessionId: String(survivingId) })).not.toBeNull();
  });
});
