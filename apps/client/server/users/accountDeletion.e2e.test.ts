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
  McpConnection as McpConnectionModel,
  McpServer,
  OAuthGrantModel,
  OAuthRefreshTokenModel,
  Organization,
  TrustedDeviceModel,
  User,
  UserApiKey,
  mcpConnectionRepository,
  oauthGrantRepository,
} from '@bike4mind/database';
import { ACCOUNT_DELETION_GRACE_DAYS, ACCOUNT_DELETION_ORG_OWNER_CODE, ApiKeyStatus } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  cancelSubscriptions: vi.fn(),
  purgeArtifacts: vi.fn(),
  withdrawListings: vi.fn(),
  revokeGrants: vi.fn(),
  sendEmail: vi.fn(),
  sendCancelledEmail: vi.fn(),
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
vi.mock('./accountDeletionEmail', () => ({
  sendAccountDeletionScheduledEmail: h.sendEmail,
  sendAccountDeletionCancelledEmail: h.sendCancelledEmail,
}));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.audit }));

import {
  cancelAccountDeletion,
  clearAccountDeletion,
  requestAccountDeletion,
  scheduleAccountDeletion,
} from './accountDeletion';
import { withAccountNotPurging } from '@server/auth/withAccountNotPurging';

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
    blogIntegration: { apiKey: 'blog-key', baseUrl: 'https://blog.example.test' },
    slackSettings: {
      slackUserId: 'U123',
      slackTeamId: 'T123',
      slackUserToken: 'xoxp-test',
      slackUserScopes: ['reminders:write'],
      notebookNamePrefix: 'Kept Prefix',
    },
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
  await TrustedDeviceModel.create({
    userId,
    tokenHash: `td-${tag}`,
    label: 'Laptop',
    expiresAt: future,
  });
  await mcpConnectionRepository.create({
    ownerType: 'user',
    ownerKey: userId,
    userId,
    slug: 'linear',
    displayName: 'Linear',
    urlEnc: 'enc:url',
    displayUrl: 'https://mcp.linear.app/mcp',
    urlHost: 'mcp.linear.app',
    transport: 'auto',
    auth: { kind: 'none' },
    status: 'connected',
    tools: [],
    enabled: true,
  });
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
    expect(h.sendEmail).toHaveBeenCalledWith(expect.stringContaining('@example.test'), user!.deletion.scheduledFor, {
      source: 'self',
    });
  });

  it('drops the trusted devices and MCP connections along with the rest of the lockdown', async () => {
    const userId = await seedAccount();
    expect(await TrustedDeviceModel.countDocuments({ userId })).toBe(1);

    await requestAccountDeletion(requestFor(userId));

    expect(await TrustedDeviceModel.countDocuments({ userId })).toBe(0);
    expect(await McpConnectionModel.countDocuments({ ownerType: 'user', ownerKey: userId })).toBe(0);
  });

  it('rolls the whole lockdown back when one revoke fails, and fails the request', async () => {
    const userId = await seedAccount();
    const revoke = vi.spyOn(oauthGrantRepository, 'revoke').mockRejectedValueOnce(new Error('revoke failed'));

    await expect(requestAccountDeletion(requestFor(userId))).rejects.toThrow('revoke failed');
    revoke.mockRestore();

    const user = await User.findById(userId).lean<{ deletion?: unknown; tokenVersion: number }>();
    expect(user!.deletion).toBeUndefined();
    expect(user!.tokenVersion).toBe(3);
    expect(await AuthSessionModel.countDocuments({ userId, revokedAt: null })).toBe(2);
    expect(await UserApiKey.countDocuments({ userId, status: { $ne: ApiKeyStatus.DISABLED } })).toBe(1);
    expect(await OAuthGrantModel.countDocuments({ userId, revokedAt: null })).toBe(1);
    expect(await OAuthRefreshTokenModel.countDocuments({ userId, revokedAt: null })).toBe(1);
    expect(await McpServer.countDocuments({ userId })).toBe(1);
    expect(await McpConnectionModel.countDocuments({ ownerType: 'user', ownerKey: userId })).toBe(1);
    expect(await TrustedDeviceModel.countDocuments({ userId })).toBe(1);
    expect(h.cancelSubscriptions).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('clears the blog key and the Slack identity and token but keeps Slack preferences', async () => {
    const userId = await seedAccount();

    await requestAccountDeletion(requestFor(userId));

    const user = await User.findById(userId)
      .select('+slackSettings.slackUserToken')
      .lean<{ blogIntegration: unknown; slackSettings: Record<string, unknown> }>();
    expect(user!.blogIntegration).toBeNull();
    expect(user!.slackSettings.slackUserId).toBeUndefined();
    expect(user!.slackSettings.slackTeamId).toBeUndefined();
    expect(user!.slackSettings.slackUserToken).toBeUndefined();
    expect(user!.slackSettings.slackUserScopes).toBeUndefined();
    expect(user!.slackSettings.notebookNamePrefix).toBe('Kept Prefix');
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

  it('does not let a personal workspace block the request', async () => {
    const userId = await seedAccount();
    await Organization.create({ name: 'Personal', userId });

    await requestAccountDeletion(requestFor(userId));

    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeDefined();
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
    const { email } = (await User.findById(userId).lean<{ email: string }>())!;
    expect(h.sendCancelledEmail).toHaveBeenCalledWith(email);
  });

  it('still cancels when the cancelled email fails', async () => {
    const userId = await seedAccount();
    h.cancelSubscriptions.mockResolvedValue({ canceled: [], failed: [] });
    await requestAccountDeletion(requestFor(userId));
    h.sendCancelledEmail.mockRejectedValueOnce(new Error('mail down'));

    await cancelAccountDeletion(requestFor(userId));

    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('deletion-cancelled email'));
  });

  it('refuses cancellation after irreversible cleanup starts, including between retries', async () => {
    const userId = await seedAccount();
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          deletion: { requestedAt: new Date(), scheduledFor: new Date(), source: 'self', purgeStartedAt: new Date() },
        },
      }
    );
    h.sendCancelledEmail.mockClear();

    await expect(cancelAccountDeletion(requestFor(userId))).rejects.toMatchObject({ statusCode: 409 });
    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeDefined();
    expect(h.sendCancelledEmail).not.toHaveBeenCalled();
  });

  it('does not insert authentication records after the purge claim commits', async () => {
    const userId = await seedAccount();
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          deletion: { requestedAt: new Date(), scheduledFor: new Date(), source: 'self', purgeStartedAt: new Date() },
        },
      }
    );
    const before = await AuthSessionModel.countDocuments({ userId });
    const insertSession = () =>
      AuthSessionModel.create({
        sid: `purging-${userId}`,
        userId,
        refreshTokenHash: 'hash',
        createdVia: 'otc',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

    await expect(withAccountNotPurging(userId, insertSession)).rejects.toMatchObject({ statusCode: 403 });
    expect(await AuthSessionModel.countDocuments({ userId })).toBe(before);
  });

  it('answers 404 when nothing is pending, and sends no email', async () => {
    const userId = await seedAccount();
    h.sendCancelledEmail.mockClear();
    await expect(cancelAccountDeletion(requestFor(userId))).rejects.toMatchObject({ statusCode: 404 });
    expect(h.sendCancelledEmail).not.toHaveBeenCalled();
  });
});

describe('support-scheduled deletion', () => {
  const received = new Date('2026-10-01T00:00:00Z');

  it('stamps source support with the received date, grace from now, and the same lockdown', async () => {
    const userId = await seedAccount();
    const recordInTransaction = vi.fn();
    const before = Date.now();

    const result = await scheduleAccountDeletion(requestFor('admin-1'), {
      userId,
      source: 'support',
      requestedAt: received,
      actorUserId: 'admin-1',
      recordInTransaction,
    });

    const user = await User.findById(userId).lean<{ deletion: Record<string, Date | string>; tokenVersion: number }>();
    expect(user!.deletion.source).toBe('support');
    expect(user!.deletion.requestedAt).toEqual(received);
    const graceMs = ACCOUNT_DELETION_GRACE_DAYS * 86_400_000;
    expect((user!.deletion.scheduledFor as Date).getTime()).toBeGreaterThanOrEqual(before + graceMs);
    expect((user!.deletion.scheduledFor as Date).getTime()).toBeLessThanOrEqual(Date.now() + graceMs);
    expect(user!.tokenVersion).toBe(4);
    expect(await UserApiKey.countDocuments({ userId, status: { $ne: ApiKeyStatus.DISABLED } })).toBe(0);
    expect(await McpServer.countDocuments({ userId })).toBe(0);
    expect(recordInTransaction).toHaveBeenCalledWith(result.deletion);
    expect(h.sendEmail).toHaveBeenCalledWith(expect.stringContaining('@example.test'), result.deletion.scheduledFor, {
      source: 'support',
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId, actorUserId: 'admin-1', event: 'account_deletion_requested' })
    );
  });

  it('stamps nothing when the in-transaction admin audit write fails', async () => {
    const userId = await seedAccount();
    h.sendEmail.mockClear();

    await expect(
      scheduleAccountDeletion(requestFor('admin-1'), {
        userId,
        source: 'support',
        requestedAt: received,
        recordInTransaction: async () => {
          throw new Error('audit down');
        },
      })
    ).rejects.toThrow('audit down');

    const user = await User.findById(userId).lean<{ deletion?: unknown; tokenVersion: number }>();
    expect(user!.deletion).toBeUndefined();
    expect(user!.tokenVersion).toBe(3);
    expect(await UserApiKey.countDocuments({ userId, status: { $ne: ApiKeyStatus.DISABLED } })).toBe(1);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('clears a pending deletion on behalf of the user, and keeps it when the audit write fails', async () => {
    const userId = await seedAccount();
    h.cancelSubscriptions.mockResolvedValue({ canceled: [], failed: [] });
    await scheduleAccountDeletion(requestFor('admin-1'), { userId, source: 'support', requestedAt: received });
    h.sendCancelledEmail.mockClear();

    await expect(
      clearAccountDeletion(requestFor('admin-1'), {
        userId,
        recordInTransaction: async () => {
          throw new Error('audit down');
        },
      })
    ).rejects.toThrow('audit down');
    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeDefined();
    expect(h.sendCancelledEmail).not.toHaveBeenCalled();

    const recordInTransaction = vi.fn();
    await clearAccountDeletion(requestFor('admin-1'), { userId, actorUserId: 'admin-1', recordInTransaction });

    expect((await User.findById(userId).lean<{ deletion?: unknown }>())!.deletion).toBeUndefined();
    expect(recordInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'support', requestedAt: received })
    );
    expect(h.sendCancelledEmail).toHaveBeenCalledTimes(1);
  });

  it('answers 404 when nothing is pending', async () => {
    const userId = await seedAccount();
    await expect(clearAccountDeletion(requestFor('admin-1'), { userId })).rejects.toMatchObject({ statusCode: 404 });
  });
});
