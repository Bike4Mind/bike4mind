/**
 * seed-oauth-client.ts
 *
 * Registers an OAuth client in B4M's MongoDB.
 * Run once per product to get a client_id + client_secret.
 *
 * Usage (from repo root):
 *   MONGODB_URI=<uri> CLIENT_NAME=VibesWire REDIRECT_URIS="https://..." \
 *     npx tsx packages/scripts/src/seed-oauth-client.ts
 *
 * To register a Pattern-A *federated* client (one allowed to mint per-user
 * `ai:generate` keys via POST /api/oauth/ai-token), also set the trust config.
 *
 * Shape 1 - the app's own Cognito pool federates B4M upstream (the default;
 * all three are required together, JWKS URI is optional because the endpoint
 * derives Cognito's `${issuer}/.well-known/jwks.json`):
 *   FEDERATED_ISSUER="https://cognito-idp.<region>.amazonaws.com/<poolId>" \
 *   FEDERATED_AUDIENCE="<cognito-app-client-id>" \
 *   FEDERATED_PROVIDER_NAME="B4M" \
 *   [FEDERATED_JWKS_URI="https://.../.well-known/jwks.json"]
 *
 * Shape 2 - the app signs users in against B4M's OIDC provider directly, so the
 * B4M user id is the token's `sub`. FEDERATED_PROVIDER_NAME is meaningless here
 * and FEDERATED_JWKS_URI is REQUIRED: B4M publishes its JWKS at /api/oauth/jwks,
 * which the derived default would never find.
 *   FEDERATED_SUBJECT_SOURCE=sub \
 *   FEDERATED_ISSUER="https://<b4m-app-url>" \
 *   FEDERATED_AUDIENCE="<this client_id>" \
 *   FEDERATED_JWKS_URI="https://<b4m-app-url>/api/oauth/jwks"
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Hand-duplicated from packages/database/src/models/auth/OAuthClientModel.ts (this
// script has no dependency on that package). MUST STAY IN SYNC: a field added there
// and not mirrored here is silently stripped at seed time.
const OAuthClientSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, required: true },
    name: { type: String, required: true },
    redirectUris: [{ type: String }],
    allowedScopes: { type: [String], default: ['openid', 'email', 'profile'] },
    pkceRequired: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    federatedIdp: {
      type: new mongoose.Schema(
        {
          issuer: { type: String, required: true },
          jwksUri: {
            type: String,
            required: function (this: { subjectSource?: string }) {
              return this.subjectSource === 'sub';
            },
          },
          audience: { type: String, required: true },
          providerName: {
            type: String,
            required: function (this: { subjectSource?: string }) {
              return this.subjectSource !== 'sub';
            },
          },
          subjectSource: { type: String, enum: ['identities', 'sub'] },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  { timestamps: true }
);

interface FederatedIdpConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  providerName?: string;
  subjectSource?: 'identities' | 'sub';
}

/**
 * Build the federated trust config from env, if provided. See the header for the two
 * shapes. `clientId` is the just-generated id, used as the default audience for the
 * `sub` shape because a B4M-issued ID token sets `aud` to the OAuth client it was
 * issued to (generateIdToken in apps/client/server/auth/oauthServer.ts).
 */
function resolveFederatedIdp(clientId: string): FederatedIdpConfig | undefined {
  const issuer = process.env.FEDERATED_ISSUER;
  const providerName = process.env.FEDERATED_PROVIDER_NAME;
  const jwksUri = process.env.FEDERATED_JWKS_URI;
  const subjectSource = process.env.FEDERATED_SUBJECT_SOURCE;

  if (subjectSource && subjectSource !== 'identities' && subjectSource !== 'sub') {
    throw new Error(`FEDERATED_SUBJECT_SOURCE must be 'identities' or 'sub', got '${subjectSource}'`);
  }

  if (subjectSource === 'sub') {
    if (!issuer) throw new Error('FEDERATED_SUBJECT_SOURCE=sub requires FEDERATED_ISSUER');
    if (!jwksUri) {
      throw new Error(
        'FEDERATED_SUBJECT_SOURCE=sub requires an explicit FEDERATED_JWKS_URI: B4M publishes its JWKS at ' +
          '<issuer>/api/oauth/jwks, and the derived /.well-known/jwks.json default would 404'
      );
    }
    return { issuer, audience: process.env.FEDERATED_AUDIENCE || clientId, jwksUri, subjectSource };
  }

  const audience = process.env.FEDERATED_AUDIENCE;
  if (!issuer && !audience && !providerName) return undefined; // not a federated client

  if (!issuer || !audience || !providerName) {
    throw new Error(
      'Federated client requires FEDERATED_ISSUER, FEDERATED_AUDIENCE, and FEDERATED_PROVIDER_NAME together'
    );
  }

  return { issuer, audience, providerName, ...(jwksUri ? { jwksUri } : {}) };
}

const OAuthClient = mongoose.model('OAuthClient', OAuthClientSchema);

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI env var required');

  const clientName = process.env.CLIENT_NAME;
  if (!clientName) throw new Error('CLIENT_NAME env var required (e.g. "VibesWire")');

  const redirectUrisRaw = process.env.REDIRECT_URIS;
  if (!redirectUrisRaw) throw new Error('REDIRECT_URIS env var required (comma-separated)');
  const redirectUris = redirectUrisRaw.split(',').map(u => u.trim());

  await mongoose.connect(mongoUri);

  const existing = await OAuthClient.findOne({ name: clientName });
  if (existing) {
    console.log(`\nClient "${clientName}" already exists:`);
    console.log('  client_id:', existing.clientId);
    console.log('\nDelete it manually if you want to re-seed.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const clientId = `b4m_${clientName.toLowerCase().replace(/\s+/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;
  const clientSecret = crypto.randomBytes(32).toString('base64url');
  const clientSecretHash = await bcrypt.hash(clientSecret, 10);

  const federatedIdp = resolveFederatedIdp(clientId);

  await OAuthClient.create({
    clientId,
    clientSecretHash,
    name: clientName,
    redirectUris,
    allowedScopes: ['openid', 'email', 'profile'],
    pkceRequired: true,
    isActive: true,
    ...(federatedIdp ? { federatedIdp } : {}),
  });

  console.log('\n✅ OAuth client registered!\n');
  console.log('  client_id    :', clientId);
  console.log('  client_secret:', clientSecret);
  if (federatedIdp) {
    console.log('  federated    : yes (may mint per-user ai:generate keys via /api/oauth/ai-token)');
    console.log('    issuer      :', federatedIdp.issuer);
    console.log('    audience    :', federatedIdp.audience);
    console.log('    subject from:', federatedIdp.subjectSource ?? 'identities');
    if (federatedIdp.providerName) console.log('    provider    :', federatedIdp.providerName);
    if (federatedIdp.jwksUri) console.log('    jwks uri    :', federatedIdp.jwksUri);
  }
  console.log(`\nSet these SST secrets in ${clientName}:`);
  console.log(`  sst secret set B4mOAuthClientId "${clientId}"`);
  console.log(`  sst secret set B4mOAuthClientSecret "${clientSecret}"`);
  console.log('\n⚠️  The client_secret will NOT be shown again.\n');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
