import mongoose from 'mongoose';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
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
import {
  STALE_API_KEY_DAYS,
  formatAccessReviewSlackMessage,
  reviewQuarter,
  type AccessReviewAdmin,
  type AccessReviewCounts,
  type AccessReviewDelegation,
  type AccessReviewSnapshot,
} from './accessReview';

/** Reads for the quarterly access review. Read-only: every query is a find, count or $match/$group. */

const MS_PER_DAY = 86_400_000;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

type Filter = Record<string, unknown>;

interface AdminDoc {
  _id: unknown;
  email?: string | null;
  username?: string | null;
  isAdmin?: boolean;
  adminPermissions?: string[];
  isBanned?: boolean;
  deletedAt?: Date | null;
  lastActiveAt?: Date | null;
}

interface KeyDoc {
  _id: unknown;
  userId: string;
  name: string;
  scopes?: string[];
  createdAt?: Date;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
}

const iso = (date: Date | null | undefined): string | null => (date ? new Date(date).toISOString() : null);

// Raw collections, so one helper serves every model and no schema hook rewrites the filter.
const count = (collection: mongoose.Collection, filter: Filter) =>
  collection.countDocuments(filter, { readPreference: 'secondaryPreferred' });

async function countByUser(collection: mongoose.Collection, filter: Filter, userIds: string[]) {
  const rows = await collection
    .aggregate<{ _id: string; n: number }>(
      [{ $match: { ...filter, userId: { $in: userIds } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }],
      { readPreference: 'secondaryPreferred' }
    )
    .toArray();
  return new Map(rows.map(row => [row._id, row.n]));
}

async function loadEmails(ids: string[]): Promise<Map<string, string | null>> {
  const objectIds = ids.filter(id => OBJECT_ID_RE.test(id)).map(id => new mongoose.Types.ObjectId(id));
  const docs = await User.find({ _id: { $in: objectIds } }, { email: 1 })
    .read('secondaryPreferred')
    .lean<Array<{ _id: unknown; email?: string | null }>>();
  return new Map(docs.map(doc => [String(doc._id), doc.email ?? null]));
}

const accountStatus = (doc: AdminDoc): AccessReviewAdmin['status'] =>
  doc.deletedAt ? 'deleted' : doc.isBanned ? 'banned' : 'active';

export interface CollectAccessReviewOptions {
  now?: Date;
  /** List every active key rather than only admin-owned and admin-scoped ones. */
  allApiKeys?: boolean;
}

const ADMIN_FILTER = { $or: [{ isAdmin: true }, { 'adminPermissions.0': { $exists: true } }] };

const collections = () => ({
  sessions: AuthSessionModel.collection,
  trustedDevices: TrustedDeviceModel.collection,
  passkeys: PasskeyCredentialModel.collection,
  oauthGrants: OAuthGrantModel.collection,
  oauthRefreshTokens: OAuthRefreshTokenModel.collection,
  bridgeDevices: CcBridgeDevice.collection,
  supportAccess: SupportAccess.collection,
  apiKeys: UserApiKey.collection,
});

function accessFilters(now: Date) {
  const sessions = { revokedAt: null, expiresAt: { $gt: now } };
  const liveKey = { status: ApiKeyStatus.ACTIVE, deletedAt: null };
  const unexpired = { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  return {
    sessions,
    trustedDevices: { expiresAt: { $gt: now } },
    passkeys: {},
    oauthGrants: { revokedAt: null },
    oauthRefreshTokens: { revokedAt: null, expiresAt: { $gt: now } },
    bridgeDevices: { revokedAt: null },
    impersonation: { ...sessions, impersonatedBy: { $nin: [null, ''] }, impersonationExpiresAt: { $gt: now } },
    supportAccess: { endedAt: null, expiresAt: { $gt: now } },
    liveKey,
    unexpired,
    activeKeys: { ...liveKey, ...unexpired },
  };
}

async function countAccess(now: Date, adminIds: string[], fullAdmins: number): Promise<AccessReviewCounts> {
  const c = collections();
  const f = accessFilters(now);
  const staleCutoff = new Date(now.getTime() - STALE_API_KEY_DAYS * MS_PER_DAY);
  const [
    activeApiKeys,
    adminScopedApiKeys,
    adminOwnedApiKeys,
    apiKeysWithoutExpiry,
    staleApiKeys,
    activeSessions,
    impersonationSessions,
    supportAccessGrants,
    trustedDevices,
    passkeys,
    oauthGrants,
    oauthRefreshTokens,
    bridgeDevices,
  ] = await Promise.all([
    count(c.apiKeys, f.activeKeys),
    count(c.apiKeys, { ...f.activeKeys, scopes: ApiKeyScope.ADMIN }),
    count(c.apiKeys, { ...f.activeKeys, userId: { $in: adminIds } }),
    count(c.apiKeys, { ...f.liveKey, expiresAt: null }),
    count(c.apiKeys, {
      ...f.liveKey,
      $and: [
        f.unexpired,
        { $or: [{ lastUsedAt: { $lt: staleCutoff } }, { lastUsedAt: null, createdAt: { $lt: staleCutoff } }] },
      ],
    }),
    count(c.sessions, f.sessions),
    count(c.sessions, f.impersonation),
    count(c.supportAccess, f.supportAccess),
    count(c.trustedDevices, f.trustedDevices),
    count(c.passkeys, f.passkeys),
    count(c.oauthGrants, f.oauthGrants),
    count(c.oauthRefreshTokens, f.oauthRefreshTokens),
    count(c.bridgeDevices, f.bridgeDevices),
  ]);
  return {
    fullAdmins,
    delegatedAdmins: adminIds.length - fullAdmins,
    activeApiKeys,
    adminScopedApiKeys,
    adminOwnedApiKeys,
    apiKeysWithoutExpiry,
    staleApiKeys,
    activeSessions,
    impersonationSessions,
    supportAccessGrants,
    trustedDevices,
    passkeys,
    oauthGrants,
    oauthRefreshTokens,
    bridgeDevices,
  };
}

/** Counts only: reads no email, username or key name, for callers that log or post the result. */
export async function collectAccessReviewCounts(now: Date): Promise<AccessReviewCounts> {
  const adminDocs = await User.find(ADMIN_FILTER, { isAdmin: 1 })
    .read('secondaryPreferred')
    .lean<Array<{ _id: unknown; isAdmin?: boolean }>>();
  const fullAdmins = adminDocs.filter(doc => doc.isAdmin === true).length;
  return countAccess(
    now,
    adminDocs.map(doc => String(doc._id)),
    fullAdmins
  );
}

export async function collectAccessReview(options: CollectAccessReviewOptions = {}): Promise<AccessReviewSnapshot> {
  const { now = new Date(), allApiKeys = false } = options;
  const c = collections();
  const f = accessFilters(now);

  const adminDocs = await User.find(ADMIN_FILTER, {
    email: 1,
    username: 1,
    isAdmin: 1,
    adminPermissions: 1,
    isBanned: 1,
    deletedAt: 1,
    lastActiveAt: 1,
  })
    .sort({ _id: 1 })
    .read('secondaryPreferred')
    .lean<AdminDoc[]>();
  const adminIds = adminDocs.map(doc => String(doc._id));

  const [sessions, trustedDevices, passkeys, oauthRefreshTokens, bridgeDevices, adminKeys] = await Promise.all([
    countByUser(c.sessions, f.sessions, adminIds),
    countByUser(c.trustedDevices, f.trustedDevices, adminIds),
    countByUser(c.passkeys, f.passkeys, adminIds),
    countByUser(c.oauthRefreshTokens, f.oauthRefreshTokens, adminIds),
    countByUser(c.bridgeDevices, f.bridgeDevices, adminIds),
    countByUser(c.apiKeys, f.activeKeys, adminIds),
  ]);
  const admins: AccessReviewAdmin[] = adminDocs.map((doc, index) => {
    const id = adminIds[index];
    return {
      userId: id,
      email: doc.email ?? null,
      username: doc.username ?? null,
      fullAdmin: doc.isAdmin === true,
      permissions: doc.adminPermissions ?? [],
      status: accountStatus(doc),
      lastActiveAt: iso(doc.lastActiveAt),
      activeSessions: sessions.get(id) ?? 0,
      trustedDevices: trustedDevices.get(id) ?? 0,
      passkeys: passkeys.get(id) ?? 0,
      oauthRefreshTokens: oauthRefreshTokens.get(id) ?? 0,
      bridgeDevices: bridgeDevices.get(id) ?? 0,
      activeApiKeys: adminKeys.get(id) ?? 0,
    };
  });

  // No limit: a review that silently drops rows is not a record.
  const keyFilter = allApiKeys
    ? f.activeKeys
    : {
        ...f.liveKey,
        $and: [f.unexpired, { $or: [{ scopes: ApiKeyScope.ADMIN }, { userId: { $in: adminIds } }] }],
      };
  // Inclusion projection: the secret, hash, digest and prefix never leave the database.
  const keyDocs = await UserApiKey.find(keyFilter, {
    userId: 1,
    name: 1,
    scopes: 1,
    createdAt: 1,
    lastUsedAt: 1,
    expiresAt: 1,
  })
    .sort({ createdAt: 1, _id: 1 })
    .read('secondaryPreferred')
    .lean<KeyDoc[]>();

  const [supportDocs, impersonationDocs, counts] = await Promise.all([
    SupportAccess.find(f.supportAccess, { adminId: 1, userId: 1, startedAt: 1, expiresAt: 1 })
      .sort({ startedAt: 1 })
      .read('secondaryPreferred')
      .lean<Array<{ adminId: string; userId: string; startedAt: Date; expiresAt: Date }>>(),
    AuthSessionModel.find(f.impersonation, {
      impersonatedBy: 1,
      userId: 1,
      createdAt: 1,
      impersonationExpiresAt: 1,
    })
      .sort({ createdAt: 1 })
      .read('secondaryPreferred')
      .lean<Array<{ impersonatedBy: string; userId: string; createdAt?: Date; impersonationExpiresAt: Date }>>(),
    countAccess(now, adminIds, admins.filter(admin => admin.fullAdmin).length),
  ]);

  const emails = new Map(admins.map(admin => [admin.userId, admin.email]));
  const unknownIds = [
    ...keyDocs.map(doc => doc.userId),
    ...supportDocs.map(doc => doc.adminId),
    ...impersonationDocs.map(doc => doc.impersonatedBy),
  ].filter(id => !emails.has(id));
  for (const [id, email] of await loadEmails([...new Set(unknownIds)])) emails.set(id, email);
  const emailOf = (id: string) => emails.get(id) ?? null;
  const adminIdSet = new Set(adminIds);

  const delegation = (adminId: string, userId: string, startedAt?: Date, expiresAt?: Date) => ({
    adminId,
    adminEmail: emailOf(adminId),
    userId,
    startedAt: iso(startedAt),
    expiresAt: iso(expiresAt),
  });
  const supportAccess: AccessReviewDelegation[] = supportDocs.map(doc =>
    delegation(doc.adminId, doc.userId, doc.startedAt, doc.expiresAt)
  );
  const impersonation: AccessReviewDelegation[] = impersonationDocs.map(doc =>
    delegation(doc.impersonatedBy, doc.userId, doc.createdAt, doc.impersonationExpiresAt)
  );

  return {
    quarter: reviewQuarter(now),
    generatedAt: now.toISOString(),
    allApiKeysListed: allApiKeys,
    counts,
    admins,
    apiKeys: keyDocs.map(doc => ({
      id: String(doc._id),
      name: doc.name,
      ownerId: doc.userId,
      ownerEmail: emailOf(doc.userId),
      ownerIsAdmin: adminIdSet.has(doc.userId),
      scopes: doc.scopes ?? [],
      createdAt: iso(doc.createdAt),
      lastUsedAt: iso(doc.lastUsedAt),
      expiresAt: iso(doc.expiresAt),
    })),
    supportAccess,
    impersonation,
  };
}

/**
 * Counts access, logs the counts as one JSON line (the CloudWatch record of the quarter's starting
 * point) and posts the reminder. The caller decides whether today is a reminder day.
 */
export async function sendAccessReviewReminder(now: Date, post: (text: string) => Promise<unknown>): Promise<string> {
  const quarter = reviewQuarter(now);
  const counts = await collectAccessReviewCounts(now);
  console.log(JSON.stringify({ report: 'access-review', quarter, generatedAt: now.toISOString(), counts }));
  await post(formatAccessReviewSlackMessage({ quarter, counts }));
  return quarter;
}
