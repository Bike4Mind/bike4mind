import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
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
} from '@bike4mind/common';
import { OAuthClientModel, type IOAuthClientDocument } from './OAuthClientModel';

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

  const clientSecret = generateOAuthClientSecret();
  const doc = await OAuthClientModel.create({
    clientId,
    clientSecretHash: await bcrypt.hash(clientSecret, OAUTH_CLIENT_SECRET_BCRYPT_ROUNDS),
    name: data.name,
    redirectUris: data.redirectUris,
    allowedScopes: federatedIdp ? FEDERATED_SCOPES : IDENTITY_SCOPES,
    // Always confidential: the client is handed a secret, so it must present it at /token.
    tokenEndpointAuthMethod: 'client_secret_post',
    clientType: data.clientType,
    isActive: true,
    ...(federatedIdp ? { federatedIdp } : {}),
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
  const finalScopes = data.allowedScopes ?? before.allowedScopes;
  const grantsOptIn = nonOptInScopes(finalScopes).length < finalScopes.length;
  if (scopesOrTrustChanged && grantsOptIn) {
    const finalFederated = data.federatedIdp === undefined ? !!before.federatedIdp : data.federatedIdp !== null;
    if (!finalFederated || before.clientType !== 'relying-party') {
      throw new BadRequestError('Opt-in scopes can only be granted to a federated relying-party client');
    }
  }

  const $set: Record<string, unknown> = {
    ...(data.redirectUris ? { redirectUris: data.redirectUris } : {}),
    ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    ...(data.allowedScopes ? { allowedScopes: data.allowedScopes } : {}),
    ...(federatedIdp ? { federatedIdp } : {}),
  };
  const update = { $set, ...(data.federatedIdp === null ? { $unset: { federatedIdp: '' } } : {}) };

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
  }

  const doc = await OAuthClientModel.findOneAndUpdate(filter, update, { new: true, runValidators: true }).exec();
  if (!doc) {
    if (Object.keys(filter).length > 1 && (await OAuthClientModel.exists({ _id: id }))) {
      throw new ConflictError(
        scopesOrTrustChanged
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
