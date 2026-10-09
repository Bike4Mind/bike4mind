import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  createOAuthClientSchema,
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

const IDENTITY_SCOPES = ['openid', 'email', 'profile'];
// A federated client mints per-user ai:generate keys via /api/oauth/ai-token, which requires the
// user to have approved ai:generate at /authorize, so the scope must be requestable there.
const FEDERATED_SCOPES = [...IDENTITY_SCOPES, 'ai:generate', 'me:read'];

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
  const before = toOAuthClientView(await findClientOrThrow(id));

  const doc = await OAuthClientModel.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true }).exec();
  if (!doc) throw new NotFoundError('OAuth client not found');

  return { before, after: toOAuthClientView(doc) };
}
