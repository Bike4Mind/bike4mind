import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  isOAuthClientScope,
  OAUTH_FEDERATED_DEFAULT_SCOPES,
  OAUTH_IDENTITY_SCOPES,
  OAUTH_OPT_IN_SCOPES,
  nonOptInScopes,
  createOAuthClientSchema,
  oauthRedirectUriSchema,
  resolveOAuthFederatedIdp,
  updateOAuthClientSchema,
  type CreateOAuthClientInput,
  type OAuthClientView,
  type OAuthClientWithSecret,
  type UpdateOAuthClientInput,
  OAUTH_CLIENT_MAX_ROLES,
  OAUTH_CLIENT_ROLE_HOLDERS_SHOWN,
  oauthClientRoleSchema,
  type OAuthClientRole,
  type OAuthClientRolesView,
  type UserOAuthClientRolesView,
  type AdminIdentity,
  assertCanActOnAdminTarget,
} from '@bike4mind/common';
import { OAuthClientModel, type IOAuthClientDocument } from './OAuthClientModel';
import { oauthClientRoleAssignmentRepository } from './OAuthClientRoleAssignmentModel';
import { User } from './UserModel';

/**
 * Registration and lifecycle of OAuth clients, shared by the admin API
 * (apps/client/pages/api/admin/oauth-clients) and packages/scripts/src/seed-oauth-client.ts.
 * Secrets are bcrypt-hashed with the same scheme verifyClientSecret checks; the plaintext only
 * leaves through the create and rotate results.
 */

export const OAUTH_CLIENT_SECRET_BCRYPT_ROUNDS = 10;

const IDENTITY_SCOPES = [...OAUTH_IDENTITY_SCOPES];
// A federated client mints per-user ai:generate keys via /api/oauth/ai-token, which requires the
// user to have approved ai:generate at /authorize, so the scope must be requestable there.
// Opt-in scopes (OAUTH_OPT_IN_SCOPES in b4m-core/common) are deliberately left out of this default.
const FEDERATED_SCOPES = [...IDENTITY_SCOPES, ...OAUTH_FEDERATED_DEFAULT_SCOPES];

// The b4m_<slug>_<8 hex> shape is parsed back by oauthClientSourceSlug (b4m-core/common/src/constants/oauthClients.ts).
export function generateOAuthClientId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
      .replace(/_+$/, '') || 'client';
  return `b4m_${slug}_${crypto.randomBytes(4).toString('hex')}`;
}

export function generateOAuthClientSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function toOAuthClientView(doc: IOAuthClientDocument): OAuthClientView {
  return {
    id: doc.id,
    clientId: doc.clientId,
    name: doc.name,
    clientType: doc.clientType,
    tokenEndpointAuthMethod: doc.tokenEndpointAuthMethod,
    redirectUris: [...(doc.redirectUris ?? [])],
    postLogoutRedirectUris: [...(doc.postLogoutRedirectUris ?? [])],
    allowedScopes: [...(doc.allowedScopes ?? [])],
    isActive: doc.isActive,
    ...(doc.federatedIdp
      ? {
          federatedIdp: {
            issuer: doc.federatedIdp.issuer,
            audience: doc.federatedIdp.audience,
            ...(doc.federatedIdp.jwksUri ? { jwksUri: doc.federatedIdp.jwksUri } : {}),
            ...(doc.federatedIdp.providerName ? { providerName: doc.federatedIdp.providerName } : {}),
            ...(doc.federatedIdp.subjectSource ? { subjectSource: doc.federatedIdp.subjectSource } : {}),
          },
        }
      : {}),
    ...(doc.overwatchProductId ? { overwatchProductId: doc.overwatchProductId } : {}),
    ...(doc.rateLimit
      ? {
          rateLimit: {
            requestsPerMinute: doc.rateLimit.requestsPerMinute,
            requestsPerDay: doc.rateLimit.requestsPerDay,
          },
        }
      : {}),
    ...(doc.unpaidAccountLimits
      ? {
          unpaidAccountLimits: {
            requestsPerMinute: doc.unpaidAccountLimits.requestsPerMinute,
            requestsPerDay: doc.unpaidAccountLimits.requestsPerDay,
            tokensPerMinute: doc.unpaidAccountLimits.tokensPerMinute,
            maxConcurrent: doc.unpaidAccountLimits.maxConcurrent,
          },
        }
      : {}),
    ...(doc.unpaidAccountsAllowed !== undefined ? { unpaidAccountsAllowed: doc.unpaidAccountsAllowed } : {}),
    roles: (doc.roles ?? []).map(role => ({ key: role.key, label: role.label })),
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

export async function listOAuthClients(): Promise<OAuthClientView[]> {
  const docs = await OAuthClientModel.find().select('-clientSecretHash').sort({ createdAt: -1 }).exec();
  return docs.map(toOAuthClientView);
}

/** Throws ZodError on invalid input, ConflictError on a duplicate name, BadRequestError on a bad trust config. */
export async function createOAuthClient(input: CreateOAuthClientInput): Promise<OAuthClientWithSecret> {
  const data = createOAuthClientSchema.parse(input);

  // Pre-check, not a guarantee: name carries no unique index, matching the seed script's behavior.
  const existing = await OAuthClientModel.exists({ name: data.name });
  if (existing) throw new ConflictError(`An OAuth client named "${data.name}" already exists`);

  const clientId = generateOAuthClientId(data.name);
  let federatedIdp;
  try {
    federatedIdp = resolveOAuthFederatedIdp(data.federatedIdp, clientId);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : String(error));
  }

  if (data.unpaidAccountLimits && !federatedIdp) {
    throw new BadRequestError('Unpaid account limits require a federated client');
  }

  const clientSecret = generateOAuthClientSecret();
  const doc = await OAuthClientModel.create({
    clientId,
    clientSecretHash: await bcrypt.hash(clientSecret, OAUTH_CLIENT_SECRET_BCRYPT_ROUNDS),
    name: data.name,
    redirectUris: data.redirectUris,
    postLogoutRedirectUris: data.postLogoutRedirectUris ?? [],
    allowedScopes: federatedIdp ? FEDERATED_SCOPES : IDENTITY_SCOPES,
    // Always confidential: the client is handed a secret, so it must present it at /token.
    tokenEndpointAuthMethod: 'client_secret_post',
    clientType: data.clientType,
    isActive: true,
    ...(federatedIdp ? { federatedIdp } : {}),
    ...(data.rateLimit ? { rateLimit: data.rateLimit } : {}),
    ...(data.unpaidAccountLimits ? { unpaidAccountLimits: data.unpaidAccountLimits } : {}),
    ...(data.unpaidAccountsAllowed !== undefined ? { unpaidAccountsAllowed: data.unpaidAccountsAllowed } : {}),
  });

  return { client: toOAuthClientView(doc), clientSecret };
}

function assertValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw new NotFoundError('OAuth client not found');
}

async function findClientOrThrow(id: string): Promise<IOAuthClientDocument> {
  assertValidId(id);
  const doc = await OAuthClientModel.findById(id).exec();
  if (!doc) throw new NotFoundError('OAuth client not found');
  return doc;
}

/** Replaces the secret hash in place, so the previous secret stops verifying on the next request. */
export async function rotateOAuthClientSecret(id: string): Promise<OAuthClientWithSecret> {
  const current = await findClientOrThrow(id);
  if (current.tokenEndpointAuthMethod !== 'client_secret_post') {
    throw new BadRequestError('This is a public (PKCE) client; it does not authenticate with a secret');
  }

  const clientSecret = generateOAuthClientSecret();
  const doc = await OAuthClientModel.findByIdAndUpdate(
    id,
    { $set: { clientSecretHash: await bcrypt.hash(clientSecret, OAUTH_CLIENT_SECRET_BCRYPT_ROUNDS) } },
    { new: true }
  ).exec();
  if (!doc) throw new NotFoundError('OAuth client not found');

  return { client: toOAuthClientView(doc), clientSecret };
}

export async function updateOAuthClient(
  id: string,
  input: UpdateOAuthClientInput
): Promise<{ before: OAuthClientView; after: OAuthClientView }> {
  const data = updateOAuthClientSchema.parse(input);
  const current = await findClientOrThrow(id);
  const before = toOAuthClientView(current);

  // Legacy clients may hold URIs today's rules reject; keep those, but hold anything new to the strict rules.
  const stored = new Set(before.redirectUris);
  for (const uri of data.redirectUris?.filter(u => !stored.has(u)) ?? []) {
    const parsed = oauthRedirectUriSchema.safeParse(uri);
    if (!parsed.success)
      throw new BadRequestError(`${uri}: ${parsed.error.issues[0]?.message ?? 'invalid redirect URI'}`);
  }

  let federatedIdp;
  if (data.federatedIdp) {
    try {
      federatedIdp = resolveOAuthFederatedIdp(data.federatedIdp, before.clientId);
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error));
    }
  }

  const storedScopes = new Set(before.allowedScopes);
  const unknownScopes = (data.allowedScopes ?? []).filter(
    scope => !storedScopes.has(scope) && !isOAuthClientScope(scope)
  );
  if (unknownScopes.length) throw new BadRequestError(`Unknown scope: ${unknownScopes.join(', ')}`);

  const scopesOrTrustChanged = data.allowedScopes !== undefined || data.federatedIdp !== undefined;
  const finalFederated = data.federatedIdp === undefined ? !!before.federatedIdp : data.federatedIdp !== null;
  const finalRateLimit = data.rateLimit === undefined ? before.rateLimit : data.rateLimit;
  if (finalRateLimit && !finalFederated) {
    throw new BadRequestError('A rate-limit profile requires a federated client');
  }
  const finalUnpaidAccountLimits =
    data.unpaidAccountLimits === undefined ? before.unpaidAccountLimits : data.unpaidAccountLimits;
  if (finalUnpaidAccountLimits && !finalFederated) {
    throw new BadRequestError('Unpaid account limits require a federated client');
  }
  const finalScopes = data.allowedScopes ?? before.allowedScopes;
  const grantsOptIn = nonOptInScopes(finalScopes).length < finalScopes.length;
  if (scopesOrTrustChanged && grantsOptIn) {
    if (!finalFederated || before.clientType !== 'relying-party') {
      throw new BadRequestError('Opt-in scopes can only be granted to a federated relying-party client');
    }
  }

  const $set: Record<string, unknown> = {
    ...(data.redirectUris ? { redirectUris: data.redirectUris } : {}),
    ...(data.postLogoutRedirectUris ? { postLogoutRedirectUris: data.postLogoutRedirectUris } : {}),
    ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    ...(data.allowedScopes ? { allowedScopes: data.allowedScopes } : {}),
    ...(federatedIdp ? { federatedIdp } : {}),
    ...(data.overwatchProductId ? { overwatchProductId: data.overwatchProductId } : {}),
    ...(data.rateLimit ? { rateLimit: data.rateLimit } : {}),
    ...(data.unpaidAccountLimits ? { unpaidAccountLimits: data.unpaidAccountLimits } : {}),
    ...(data.unpaidAccountsAllowed !== undefined ? { unpaidAccountsAllowed: data.unpaidAccountsAllowed } : {}),
  };
  const $unset: Record<string, ''> = {
    ...(data.federatedIdp === null ? { federatedIdp: '' } : {}),
    ...(data.overwatchProductId === null ? { overwatchProductId: '' } : {}),
    ...(data.rateLimit === null ? { rateLimit: '' } : {}),
    ...(data.unpaidAccountLimits === null ? { unpaidAccountLimits: '' } : {}),
  };
  const update = { $set, ...(Object.keys($unset).length > 0 ? { $unset } : {}) };

  // Exact-match the lists we validated against, so a concurrent edit cannot slip an unchecked value past them.
  const filter: Record<string, unknown> = { _id: id };
  if (data.redirectUris) filter.redirectUris = before.redirectUris;
  if (scopesOrTrustChanged) filter.allowedScopes = before.allowedScopes;
  if (data.federatedIdp !== undefined) {
    // Per field, not the whole subdocument: subdocument equality depends on key order. null matches absent.
    for (const key of ['issuer', 'audience', 'jwksUri', 'providerName', 'subjectSource'] as const) {
      filter[`federatedIdp.${key}`] = before.federatedIdp?.[key] ?? null;
    }
  } else if (scopesOrTrustChanged && grantsOptIn) {
    // Federation must still exist when this write leaves an opt-in scope in place.
    filter.federatedIdp = { $exists: true };
    filter.clientType = 'relying-party';
  }
  if (data.expectedUpdatedAt !== undefined) {
    filter.updatedAt = data.expectedUpdatedAt === null ? null : new Date(data.expectedUpdatedAt);
  }
  if (data.rateLimit !== undefined || data.federatedIdp !== undefined) {
    filter['rateLimit.requestsPerMinute'] = before.rateLimit?.requestsPerMinute ?? null;
    filter['rateLimit.requestsPerDay'] = before.rateLimit?.requestsPerDay ?? null;
    if (data.federatedIdp === undefined) filter.federatedIdp = { $exists: finalFederated };
  }

  if (data.unpaidAccountLimits !== undefined || data.federatedIdp !== undefined) {
    for (const key of ['requestsPerMinute', 'requestsPerDay', 'tokensPerMinute', 'maxConcurrent'] as const) {
      filter[`unpaidAccountLimits.${key}`] = before.unpaidAccountLimits?.[key] ?? null;
    }
    if (data.federatedIdp === undefined) filter.federatedIdp = { $exists: finalFederated };
  }

  const doc = await OAuthClientModel.findOneAndUpdate(filter, update, { new: true, runValidators: true }).exec();
  if (!doc) {
    if (Object.keys(filter).length > 1 && (await OAuthClientModel.exists({ _id: id }))) {
      throw new ConflictError(
        scopesOrTrustChanged || data.expectedUpdatedAt !== undefined || data.unpaidAccountLimits !== undefined
          ? 'OAuth client changed while saving; reload and try again'
          : 'Redirect URIs changed while saving; reload and try again'
      );
    }
    throw new NotFoundError('OAuth client not found');
  }

  return { before, after: toOAuthClientView(doc) };
}

/**
 * Adds opt-in scopes to an existing federated relying-party client. Idempotent ($addToSet), so a rerun
 * is a no-op. Relying-party only: first-party clients skip the grant gate (federatedGrantGate.ts), so
 * the scope would reach them with no user consent. Throws BadRequestError on an empty list, a scope
 * outside OAUTH_OPT_IN_SCOPES, or a client that is not federated or not a relying party; NotFoundError
 * when no client has that clientId. An admin removes an opt-in scope through updateOAuthClient
 * (the admin console edit form).
 */
export async function addOAuthClientOptInScopes(clientId: string, scopes: readonly string[]): Promise<OAuthClientView> {
  if (scopes.length === 0) throw new BadRequestError('No opt-in scopes given');
  const unknown = nonOptInScopes(scopes);
  if (unknown.length) {
    throw new BadRequestError(
      `Not an opt-in scope: ${unknown.join(', ')} (allowed: ${OAUTH_OPT_IN_SCOPES.join(', ')})`
    );
  }

  const doc = await OAuthClientModel.findOneAndUpdate(
    { clientId, federatedIdp: { $exists: true }, clientType: 'relying-party' },
    { $addToSet: { allowedScopes: { $each: [...scopes] } } },
    { new: true }
  ).exec();
  if (!doc) {
    if (await OAuthClientModel.exists({ clientId })) {
      throw new BadRequestError('Opt-in scopes can only be granted to a federated relying-party client');
    }
    throw new NotFoundError('OAuth client not found');
  }
  return toOAuthClientView(doc);
}

type RoleUser = { id: string; email: string | null; name: string | null };

async function findUserOrThrow(userId: string): Promise<RoleUser> {
  const user = mongoose.isValidObjectId(userId)
    ? await User.findOne({ _id: userId, deletedAt: { $exists: false } })
        .select('email name')
        .lean<{ _id: unknown; email?: string; name?: string }>()
        .exec()
    : null;
  if (!user) throw new NotFoundError('User not found');
  return { id: String(user._id), email: user.email || null, name: user.name || null };
}

// Every role writer locks the client before validating roles or changing assignments.
const withLockedRoleClient = <T>(
  filter: { _id: string } | { clientId: string },
  change: (client: IOAuthClientDocument, session: mongoose.mongo.ClientSession) => Promise<T>
): Promise<T> =>
  withTransaction(async session => {
    const client = await OAuthClientModel.findOneAndUpdate(
      filter,
      { $inc: { roleMutationVersion: 1 } },
      { new: true, session, timestamps: false, runValidators: true }
    ).exec();
    if (!client) throw new NotFoundError('OAuth client not found');
    return change(client, session);
  });

/** Throws ZodError on an invalid role, ConflictError on a duplicate key, BadRequestError past the role limit. */
export async function addOAuthClientRole(
  id: string,
  input: OAuthClientRole
): Promise<{ client: OAuthClientView; role: OAuthClientRole }> {
  const role = oauthClientRoleSchema.parse(input);
  assertValidId(id);
  return withLockedRoleClient({ _id: id }, async (current, session) => {
    if (current.roles.length >= OAUTH_CLIENT_MAX_ROLES) {
      throw new BadRequestError(`A client can offer at most ${OAUTH_CLIENT_MAX_ROLES} roles`);
    }
    if (current.roles.some(existing => existing.key === role.key)) {
      throw new ConflictError(`This client already has a role "${role.key}"`);
    }
    const doc = await OAuthClientModel.findOneAndUpdate(
      { _id: id },
      { $push: { roles: role } },
      { new: true, runValidators: true, session }
    ).exec();
    if (!doc) throw new NotFoundError('OAuth client not found');
    await oauthClientRoleAssignmentRepository.deleteAllForClient(doc.clientId, role.key, session);
    return { client: toOAuthClientView(doc), role };
  });
}

/**
 * Removes the role from the client and deletes every assignment of it. With `actor`, a delegated admin is
 * refused (ForbiddenError) when any current holder has admin access; the holders are read under the client lock.
 */
export async function removeOAuthClientRole(
  id: string,
  key: string,
  options: { actor?: AdminIdentity } = {}
): Promise<{
  client: OAuthClientView;
  role: OAuthClientRole;
  removedAssignments: number;
  removedUserIds: string[];
}> {
  assertValidId(id);
  return withLockedRoleClient({ _id: id }, async (current, session) => {
    const role = current.roles.find(existing => existing.key === key);
    if (!role) throw new NotFoundError('Role not found on this client');
    const removedUserIds = await oauthClientRoleAssignmentRepository.listUserIdsForRole(current.clientId, key, session);
    if (options.actor) {
      const holders = await User.find({ _id: { $in: removedUserIds.filter(uid => mongoose.isValidObjectId(uid)) } })
        .select('isAdmin adminPermissions adminRoleIds')
        .session(session)
        .lean<AdminIdentity[]>()
        .exec();
      for (const holder of holders) assertCanActOnAdminTarget(options.actor, holder, 'remove an app role from');
    }
    const doc = await OAuthClientModel.findOneAndUpdate(
      { _id: id },
      { $pull: { roles: { key } } },
      { new: true, runValidators: true, session }
    ).exec();
    if (!doc) throw new NotFoundError('OAuth client not found');
    const removedAssignments = await oauthClientRoleAssignmentRepository.deleteAllForClient(doc.clientId, key, session);
    return {
      client: toOAuthClientView(doc),
      role: { key: role.key, label: role.label },
      removedAssignments,
      removedUserIds,
    };
  });
}

/** The client's roles, how many hold each and the earliest holders; assignments of an undefined role are left out. */
export async function listOAuthClientRoles(id: string): Promise<OAuthClientRolesView> {
  const client = await findClientOrThrow(id);
  const byRole = await oauthClientRoleAssignmentRepository.listHoldersByClient(
    client.clientId,
    client.roles.map(r => r.key),
    OAUTH_CLIENT_ROLE_HOLDERS_SHOWN
  );
  const rows = byRole.flatMap(r => r.rows);
  const users = await User.find({ _id: { $in: [...new Set(rows.map(r => r.userId))] } })
    .select('email name')
    .lean<Array<{ _id: { toString(): string }; email?: string; name?: string }>>()
    .exec();
  const byId = new Map(users.map(u => [u._id.toString(), u]));
  return {
    roles: toOAuthClientView(client).roles,
    holders: rows.map(row => {
      const user = byId.get(row.userId.toLowerCase());
      return {
        userId: user?._id.toString() ?? row.userId,
        role: row.role,
        email: user?.email || null,
        name: user?.name || null,
        assignedBy: row.assignedBy,
        assignedAt: new Date(row.assignedAt).toISOString(),
      };
    }),
    holderCounts: Object.fromEntries(byRole.map(r => [r.role, r.count])),
  };
}

/**
 * Every client that offers roles or on which the user holds one, with the user's assignments. Lists
 * assignments for a suspended user too: this is the admin view, not what a client can read
 * (listRolesForUserAndClient in OAuthClientRoleAssignmentModel.ts).
 */
export async function listUserOAuthClientRoles(userId: string): Promise<UserOAuthClientRolesView[]> {
  const user = await findUserOrThrow(userId);
  const rows = await oauthClientRoleAssignmentRepository.listByUser(user.id);
  const clients = await OAuthClientModel.find({
    $or: [{ 'roles.0': { $exists: true } }, { clientId: { $in: rows.map(r => r.clientId) } }],
  })
    .sort({ name: 1 })
    .exec();
  return clients.map(client => {
    const { roles } = toOAuthClientView(client);
    const labels = new Map(roles.map(r => [r.key, r.label]));
    return {
      clientId: client.clientId,
      clientName: client.name,
      isActive: client.isActive,
      roles,
      assigned: rows
        .filter(r => r.clientId === client.clientId && labels.has(r.role))
        .map(r => ({
          role: r.role,
          label: labels.get(r.role) as string,
          assignedBy: r.assignedBy,
          assignedAt: new Date(r.assignedAt).toISOString(),
        })),
    };
  });
}

type RoleAssignmentResult = { client: OAuthClientView; user: RoleUser; role: OAuthClientRole };

/** Idempotent; `created` is false when the user already held the role. Throws BadRequestError for a role the client does not define. */
export async function assignOAuthClientRole(params: {
  userId: string;
  clientId: string;
  role: string;
  assignedBy: string;
}): Promise<RoleAssignmentResult & { created: boolean }> {
  const user = await findUserOrThrow(params.userId);
  return withLockedRoleClient({ clientId: params.clientId }, async (doc, session) => {
    const client = toOAuthClientView(doc);
    const role = client.roles.find(existing => existing.key === params.role);
    if (!role) throw new BadRequestError(`This client does not offer a role "${params.role}"`);
    // A real User write orders this grant with account deletion and its post-commit role purge.
    const admission = await User.updateOne(
      { _id: user.id, deletedAt: { $exists: false } },
      { $inc: { __v: 1 } },
      { session, timestamps: false, runValidators: true }
    ).exec();
    if (!admission.matchedCount) throw new NotFoundError('User not found');
    const { created } = await oauthClientRoleAssignmentRepository.assign(
      {
        userId: user.id,
        clientId: client.clientId,
        role: role.key,
        assignedBy: params.assignedBy,
      },
      session
    );
    return { client, user, role, created };
  });
}

/** Deletes the assignment; NotFoundError when the user does not hold the role. */
export async function unassignOAuthClientRole(params: {
  userId: string;
  clientId: string;
  role: string;
}): Promise<RoleAssignmentResult> {
  const user = await findUserOrThrow(params.userId);
  return withLockedRoleClient({ clientId: params.clientId }, async (doc, session) => {
    const client = toOAuthClientView(doc);
    const removed = await oauthClientRoleAssignmentRepository.unassign(user.id, client.clientId, params.role, session);
    if (!removed) throw new NotFoundError('This user does not hold that role');
    // A removed role keeps its key as the audit label.
    const role = client.roles.find(existing => existing.key === params.role) ?? {
      key: params.role,
      label: params.role,
    };
    return { client, user, role };
  });
}
