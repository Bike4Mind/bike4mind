import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Request } from 'express';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import {
  AuthSessionModel,
  McpServer,
  OAuthGrantModel,
  OAuthRefreshTokenModel,
  Organization,
  User,
  UserApiKey,
} from '@bike4mind/database';
import { ACCOUNT_DELETION_GRACE_DAYS, ACCOUNT_DELETION_ORG_OWNER_CODE, ApiKeyStatus } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  cancelSubscriptions: vi.fn(),
  purgeArtifacts: vi.fn(),
  withdrawListings: vi.fn(),
  revokeGrants: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({ cancelAccountSubscriptions: h.cancelSubscriptions }));
vi.mock('@server/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: h.purgeArtifacts,
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ withdrawAuthorListings: h.withdrawListings }));
vi.mock('@server/services/purgeDeletedUserData', async () => {
  const { User: UserModel } = await import('@bike4mind/database');
  return {
    readUserIntegrationGrants: (id: string) => UserModel.findById(id, 'googleDrive atlassianConnect').lean(),
    revokeIntegrationGrants: h.revokeGrants,
  };
});
vi.mock('./accountDeletionEmail', () => ({ sendAccountDeletionScheduledEmail: h.sendEmail }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.audit }));

import { cancelAccountDeletion, requestAccountDeletion } from './accountDeletion';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let db: MongoMemoryReplSet;
beforeAll(async () => {
  db = await createMongoReplSet();
  await mongoose.connect(db.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await db?.stop();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };

const requestFor = (userId: string, over: Record<string, unknown> = {}) =>
  ({ user: { id: userId, ...over }, logger, headers: {}, socket: {} }) as unknown as Request;

async function seedAccount() {
  const tag = Math.random().toString(36).slice(2, 10);
  const user = await User.create({
    name: 'Dev',
    username: `dev-${tag}`,
    email: `dev-${tag}@example.test`,
    password: null,
    hasUsablePassword: false,
    emailVerified: true,
    currentCredits: 0,
    tokenVersion: 3,
  });
  const userId = user.id as string;
  const future = new Date(Date.now() + 86_400_000);
  await AuthSessionModel.create([
    { sid: `a-${tag}`, userId, refreshTokenHash: 'h', createdVia: 'otc', lastUsedAt: new Date(), expiresAt: future },
    { sid: `b-${tag}`, userId, refreshTokenHash: 'h', createdVia: 'oauth', lastUsedAt: new Date(), expiresAt: future },
  ]);
  await UserApiKey.create({
    userId,
    name: 'k',
    keyPrefix: `b4m_${tag}`,
    keyHash: 'x',
    scopes: [],
    metadata: { createdFrom: 'dashboard' },
  });
  await OAuthGrantModel.create({ userId, clientId: `client-${tag}`, scopes: ['profile'] });
  await OAuthRefreshTokenModel.create({
    familyId: `fam-${tag}`,
    userId,
    clientId: `client-${tag}`,
    tokenHash: 'h',
    expiresAt: future,
  });
  await McpServer.create({ name: 'github', userId, enabled: true, env: [] });
  return userId;
}

describe('requestAccountDeletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cancelSubscriptions.mockResolvedValue({ canceled: ['sub_1'], failed: [] });
  });

  it('stamps the deletion and revokes sessions, API keys, app grants and MCP connections at once', async () => {
    const userId = await seedAccount();
    const now = new Date('2026-11-03T12:00:00.000Z');

    const result = await requestAccountDeletion(requestFor(userId), now);

    const user = await User.findById(userId).lean<{
      deletion: { scheduledFor: Date; source: string };
      tokenVersion: number;
    }>();
    expect(user!.deletion.source).toBe('self');
    expect(user!.deletion.scheduledFor.getTime() - now.getTime()).toBe(ACCOUNT_DELETION_GRACE_DAYS * 86_400_000);
    expect(user!.tokenVersion).toBe(4);
    expect(await AuthSessionModel.countDocuments({ userId, revokedAt: null })).toBe(0);
    expect(await UserApiKey.countDocuments({ userId, status: { $ne: ApiKeyStatus.DISABLED } })).toBe(0);
    expect(await OAuthGrantModel.countDocuments({ userId, revokedAt: null })).toBe(0);
    expect(await OAuthRefreshTokenModel.countDocuments({ userId, revokedAt: null })).toBe(0);
    expect(await McpServer.countDocuments({ userId })).toBe(0);
    expect(h.revokeGrants).toHaveBeenCalledWith(userId, expect.anything(), logger, 'deletion-pending user');

    expect(h.cancelSubscriptions).toHaveBeenCalledWith({ userId, reason: 'deletion_requested' }, logger);
    expect(result.subscriptions.canceled).toEqual(['sub_1']);
    expect(h.purgeArtifacts).toHaveBeenCalledWith(userId, { deletedBy: userId, logger });
    expect(h.withdrawListings).toHaveBeenCalledWith(userId);
    expect(h.sendEmail).toHaveBeenCalledWith(expect.stringContaining('@example.test'), user!.deletion.scheduledFor);
  });

  it('refuses an organization owner with the organizations to transfer, and changes nothing', async () => {
    const userId = await seedAccount();
    const org = await Organization.create({ name: 'Acme', userId, personal: false });

    await expect(requestAccountDeletion(requestFor(userId))).rejects.toMatchObject({
      statusCode: 409,
      additionalInfo: {
        code: ACCOUNT_DELETION_ORG_OWNER_CODE,
        organizations: [{ id: org.id, name: 'Acme' }],
      },
    });
    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeUndefined();
    expect(await AuthSessionModel.countDocuments({ userId, revokedAt: null })).toBe(2);
    expect(h.cancelSubscriptions).not.toHaveBeenCalled();
  });

  it('refuses a second request while one is pending', async () => {
    const userId = await seedAccount();
    await requestAccountDeletion(requestFor(userId));
    vi.clearAllMocks();
    await expect(requestAccountDeletion(requestFor(userId))).rejects.toMatchObject({ statusCode: 409 });
    expect(h.cancelSubscriptions).not.toHaveBeenCalled();
  });

  it('refuses an impersonated session', async () => {
    const userId = await seedAccount();
    await expect(requestAccountDeletion(requestFor(userId, { impersonatedBy: 'admin' }))).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('cancelAccountDeletion', () => {
  it('clears the scheduled purge and leaves what was revoked revoked', async () => {
    const userId = await seedAccount();
    h.cancelSubscriptions.mockResolvedValue({ canceled: [], failed: [] });
    await requestAccountDeletion(requestFor(userId));

    await cancelAccountDeletion(requestFor(userId));

    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeUndefined();
    expect(await UserApiKey.countDocuments({ userId, status: { $ne: ApiKeyStatus.DISABLED } })).toBe(0);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), { userId, event: 'account_deletion_cancelled' });
  });

  it('answers 404 when nothing is pending', async () => {
    const userId = await seedAccount();
    await expect(cancelAccountDeletion(requestFor(userId))).rejects.toMatchObject({ statusCode: 404 });
  });
});
