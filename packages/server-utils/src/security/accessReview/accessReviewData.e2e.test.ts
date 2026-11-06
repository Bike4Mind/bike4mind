import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  AuthSessionModel,
  CcBridgeDevice,
  OAuthGrantModel,
  OAuthRefreshTokenModel,
  PasskeyCredentialModel,
  SupportAccess,
  TrustedDeviceModel,
  User,
  UserApiKey,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../database/src/__test__/createMongoServer';
import { collectAccessReview, collectAccessReviewCounts, sendAccessReviewReminder } from './accessReviewData';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;

const now = new Date('2027-01-04T09:00:00Z');
const past = new Date('2026-12-01T00:00:00Z');
const longAgo = new Date('2026-06-01T00:00:00Z');
const future = new Date('2027-06-01T00:00:00Z');
const id = () => new mongoose.Types.ObjectId();

const full = id();
const delegated = id();
const deleted = id();
const plain = id();
const formerAdmin = id();
const [fullId, delegatedId, deletedId, plainId, formerAdminId] = [full, delegated, deleted, plain, formerAdmin].map(
  String
);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());

  await User.collection.insertMany([
    {
      _id: full,
      username: 'root',
      email: 'root@example.org',
      isAdmin: true,
      adminPermissions: [],
      lastActiveAt: past,
      password: 'NEVER_IN_REPORT',
    },
    { _id: delegated, isAdmin: false, adminPermissions: ['support:read'], isBanned: true },
    { _id: deleted, username: 'gone', email: 'gone@example.org', isAdmin: true, deletedAt: past },
    { _id: plain, username: 'plain', email: 'plain@example.org', isAdmin: false, adminPermissions: [] },
    { _id: formerAdmin, username: 'former', isAdmin: false },
  ]);

  await UserApiKey.collection.insertMany([
    // Admin-owned, no expiry, used recently.
    {
      _id: id(),
      userId: fullId,
      name: 'root key',
      keyHash: 'HASH_NEVER_IN_REPORT',
      keyDigest: 'DIGEST_NEVER_IN_REPORT',
      keyPrefix: 'PREFIX_NEVER_IN_REPORT',
      scopes: ['ai:generate'],
      status: 'active',
      createdAt: longAgo,
      lastUsedAt: past,
      deletedAt: null,
    },
    // A plain user's admin-scoped key with a future expiry, never used for longer than the stale window.
    {
      _id: id(),
      userId: plainId,
      name: 'ops key',
      keyPrefix: 'p2',
      scopes: ['admin:*'],
      status: 'active',
      createdAt: longAgo,
      expiresAt: future,
    },
    // A plain user's ordinary key, created without scopes or timestamps: counted, not listed.
    { _id: id(), userId: plainId, name: 'reader', keyPrefix: 'p3', status: 'active' },
    // Excluded everywhere: expired, disabled, soft-deleted.
    { _id: id(), userId: fullId, name: 'expired', keyPrefix: 'p4', status: 'active', expiresAt: past },
    { _id: id(), userId: fullId, name: 'disabled', keyPrefix: 'p5', status: 'disabled' },
    { _id: id(), userId: fullId, name: 'deleted', keyPrefix: 'p6', status: 'active', deletedAt: past },
    // Owned by an account that is not an admin and has no email: listed only with every key.
    { _id: id(), userId: 'not-an-object-id', name: 'orphan', keyPrefix: 'p7', status: 'active', createdAt: past },
  ]);

  await AuthSessionModel.collection.insertMany([
    { sid: 's1', userId: fullId, revokedAt: null, expiresAt: future, impersonatedBy: null },
    { sid: 's2', userId: fullId, revokedAt: past, expiresAt: future },
    {
      sid: 's3',
      userId: plainId,
      revokedAt: null,
      expiresAt: future,
      impersonatedBy: delegatedId,
      impersonationExpiresAt: future,
    },
    {
      sid: 's4',
      userId: plainId,
      revokedAt: null,
      expiresAt: future,
      impersonatedBy: formerAdminId,
      impersonationExpiresAt: future,
      createdAt: past,
    },
    // Impersonation that has lapsed although the session itself is live.
    {
      sid: 's5',
      userId: plainId,
      revokedAt: null,
      expiresAt: future,
      impersonatedBy: fullId,
      impersonationExpiresAt: past,
    },
  ]);
  await TrustedDeviceModel.collection.insertMany([
    { userId: fullId, tokenHash: 't1', expiresAt: future },
    { userId: fullId, tokenHash: 't2', expiresAt: past },
  ]);
  await PasskeyCredentialModel.collection.insertMany([
    { userId: delegatedId, credentialId: 'c1' },
    { userId: plainId, credentialId: 'c2' },
  ]);
  await OAuthGrantModel.collection.insertMany([
    { userId: plainId, clientId: 'app', revokedAt: null },
    { userId: plainId, clientId: 'old', revokedAt: past },
  ]);
  await OAuthRefreshTokenModel.collection.insertMany([
    { familyId: 'f1', userId: fullId, revokedAt: null, expiresAt: future },
    { familyId: 'f2', userId: fullId, revokedAt: null, expiresAt: past },
  ]);
  await CcBridgeDevice.collection.insertMany([
    { userId: fullId, deviceLabel: 'laptop', apiKeyId: 'b1' },
    { userId: fullId, deviceLabel: 'old', apiKeyId: 'b2', revokedAt: past },
  ]);
  await SupportAccess.collection.insertMany([
    { sid: 's3', userId: plainId, adminId: delegatedId, startedAt: past, expiresAt: future, endedAt: null },
    { sid: 'a2', userId: plainId, adminId: fullId, startedAt: past, expiresAt: future, endedAt: past },
    { sid: 's4', userId: plainId, adminId: formerAdminId, startedAt: longAgo, expiresAt: future },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('collectAccessReview', () => {
  it('enumerates privileged access and counts every grant without reading secrets', async () => {
    const snapshot = await collectAccessReview({ now });

    expect(snapshot.quarter).toBe('2027-Q1');
    expect(snapshot.generatedAt).toBe(now.toISOString());
    expect(snapshot.allApiKeysListed).toBe(false);
    expect(snapshot.counts).toEqual({
      fullAdmins: 2,
      delegatedAdmins: 1,
      activeApiKeys: 4,
      adminScopedApiKeys: 1,
      adminOwnedApiKeys: 1,
      apiKeysWithoutExpiry: 3,
      staleApiKeys: 1,
      activeSessions: 3,
      impersonationSessions: 2,
      supportAccessGrants: 2,
      trustedDevices: 1,
      passkeys: 2,
      oauthGrants: 1,
      oauthRefreshTokens: 1,
      bridgeDevices: 1,
    });

    expect(snapshot.admins).toEqual([
      {
        userId: fullId,
        email: 'root@example.org',
        username: 'root',
        fullAdmin: true,
        permissions: [],
        status: 'active',
        lastActiveAt: past.toISOString(),
        activeSessions: 1,
        trustedDevices: 1,
        passkeys: 0,
        oauthRefreshTokens: 1,
        bridgeDevices: 1,
        activeApiKeys: 1,
      },
      {
        userId: delegatedId,
        email: null,
        username: null,
        fullAdmin: false,
        permissions: ['support:read'],
        status: 'banned',
        lastActiveAt: null,
        activeSessions: 0,
        trustedDevices: 0,
        passkeys: 1,
        oauthRefreshTokens: 0,
        bridgeDevices: 0,
        activeApiKeys: 0,
      },
      expect.objectContaining({ userId: deletedId, status: 'deleted', fullAdmin: true, permissions: [] }),
    ]);

    expect(snapshot.apiKeys).toEqual([
      expect.objectContaining({
        name: 'root key',
        ownerId: fullId,
        ownerEmail: 'root@example.org',
        ownerIsAdmin: true,
        scopes: ['ai:generate'],
        createdAt: longAgo.toISOString(),
        lastUsedAt: past.toISOString(),
        expiresAt: null,
      }),
      expect.objectContaining({
        name: 'ops key',
        ownerEmail: 'plain@example.org',
        ownerIsAdmin: false,
        scopes: ['admin:*'],
        lastUsedAt: null,
        expiresAt: future.toISOString(),
      }),
    ]);

    expect(snapshot.supportAccess).toEqual([
      {
        sessionId: 's4',
        adminId: formerAdminId,
        adminEmail: null,
        userId: plainId,
        startedAt: longAgo.toISOString(),
        expiresAt: future.toISOString(),
      },
      {
        sessionId: 's3',
        adminId: delegatedId,
        adminEmail: null,
        userId: plainId,
        startedAt: past.toISOString(),
        expiresAt: future.toISOString(),
      },
    ]);
    expect(snapshot.impersonation).toEqual([
      {
        sessionId: 's3',
        adminId: delegatedId,
        adminEmail: null,
        userId: plainId,
        startedAt: null,
        expiresAt: future.toISOString(),
      },
      {
        sessionId: 's4',
        adminId: formerAdminId,
        adminEmail: null,
        userId: plainId,
        startedAt: past.toISOString(),
        expiresAt: future.toISOString(),
      },
    ]);

    const serialized = JSON.stringify(snapshot);
    for (const secret of ['NEVER_IN_REPORT', 'p2', 'keyHash', 'keyDigest', 'keyPrefix']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('excludes inactive sessions and support grants from both report paths', async () => {
    const before = await collectAccessReview({ now });
    const sessionCases = [
      { sid: 'review-ordinary' },
      { sid: 'review-empty-marker', impersonatedBy: '' },
      { sid: 'review-live', impersonatedBy: delegatedId, impersonationExpiresAt: future },
      { sid: 'review-ended', impersonatedBy: delegatedId, impersonationExpiresAt: future },
      { sid: 'review-expired-impersonation', impersonatedBy: delegatedId, impersonationExpiresAt: past },
      { sid: 'review-missing-deadline', impersonatedBy: delegatedId },
      { sid: 'review-deadline-boundary', impersonatedBy: delegatedId, impersonationExpiresAt: now },
      { sid: 'review-expired-session', expiresAt: past },
      { sid: 'review-session-boundary', expiresAt: now },
      { sid: 'review-revoked', revokedAt: past, impersonatedBy: delegatedId, impersonationExpiresAt: future },
    ];
    const supportCases = [
      { sid: 'review-live' },
      { sid: 'review-ended', endedAt: past },
      { sid: 'review-expired-impersonation' },
      { sid: 'review-missing-deadline' },
      { sid: 'review-deadline-boundary' },
      { sid: 'review-expired-session' },
      { sid: 'review-session-boundary' },
      { sid: 'review-revoked' },
      { sid: 'review-missing-session' },
    ];
    const sessionIds = sessionCases.map(session => session.sid);
    const supportIds = supportCases.map(grant => grant.sid);
    try {
      await AuthSessionModel.collection.insertMany(
        sessionCases.map(session => ({ userId: fullId, revokedAt: null, expiresAt: future, ...session }))
      );
      await SupportAccess.collection.insertMany(
        supportCases.map(grant => ({
          userId: fullId,
          adminId: delegatedId,
          startedAt: past,
          expiresAt: future,
          endedAt: null,
          ...grant,
        }))
      );
      const after = await collectAccessReview({ now });
      expect(after.counts.activeSessions).toBe(before.counts.activeSessions + 4);
      expect(after.counts.impersonationSessions).toBe(before.counts.impersonationSessions + 2);
      expect(after.admins.find(admin => admin.userId === fullId)?.activeSessions).toBe(5);
      expect(after.counts.supportAccessGrants).toBe(before.counts.supportAccessGrants + 1);
      expect(
        after.impersonation
          .filter(grant => grant.userId === fullId)
          .map(grant => grant.sessionId)
          .sort()
      ).toEqual(['review-ended', 'review-live']);
      expect(after.supportAccess.filter(grant => grant.userId === fullId)).toEqual([
        {
          sessionId: 'review-live',
          adminId: delegatedId,
          adminEmail: null,
          userId: fullId,
          startedAt: past.toISOString(),
          expiresAt: future.toISOString(),
        },
      ]);
      await expect(collectAccessReviewCounts(now)).resolves.toEqual(after.counts);
    } finally {
      await SupportAccess.collection.deleteMany({ sid: { $in: supportIds } });
      await AuthSessionModel.collection.deleteMany({ sid: { $in: sessionIds } });
    }
  });

  it('returns zero live support grants when all grants have expired', async () => {
    const snapshot = await collectAccessReview({ now: future });
    expect(snapshot.counts.supportAccessGrants).toBe(0);
    expect(snapshot.supportAccess).toEqual([]);
    expect(snapshot.counts.activeSessions).toBe(0);
    expect(snapshot.counts.impersonationSessions).toBe(0);
  });

  it('lists every active key on request, oldest first', async () => {
    const snapshot = await collectAccessReview({ now, allApiKeys: true });
    expect(snapshot.allApiKeysListed).toBe(true);
    expect(snapshot.apiKeys.map(key => key.name)).toEqual(['reader', 'root key', 'ops key', 'orphan']);
    expect(snapshot.apiKeys[0]).toEqual(expect.objectContaining({ scopes: [], createdAt: null, ownerIsAdmin: false }));
    expect(snapshot.apiKeys[3]).toEqual(expect.objectContaining({ ownerId: 'not-an-object-id', ownerEmail: null }));
  });

  it('counts the same grants on the counts-only path', async () => {
    const snapshot = await collectAccessReview({ now });
    await expect(collectAccessReviewCounts(now)).resolves.toEqual(snapshot.counts);
  });

  it('defaults to the current time', async () => {
    const snapshot = await collectAccessReview();
    expect(Date.now() - new Date(snapshot.generatedAt).getTime()).toBeLessThan(60_000);
  });
});

describe('sendAccessReviewReminder', () => {
  it('logs the counts as one JSON line and posts the reminder', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const post = vi.fn().mockResolvedValue(undefined);

    await expect(sendAccessReviewReminder(now, post)).resolves.toBe('2027-Q1');

    const logged = JSON.parse(String(log.mock.calls[0][0]));
    expect(logged).toEqual(
      expect.objectContaining({ report: 'access-review', quarter: '2027-Q1', generatedAt: now.toISOString() })
    );
    expect(logged.counts.fullAdmins).toBe(2);
    expect(post).toHaveBeenCalledWith(expect.stringContaining('*Quarterly access review due: 2027-Q1*'));
    const posted = `${log.mock.calls[0][0]}${post.mock.calls[0][0]}`;
    for (const detail of ['@example.org', 'root', fullId, 'ops key']) expect(posted).not.toContain(detail);
    log.mockRestore();
  });
});
