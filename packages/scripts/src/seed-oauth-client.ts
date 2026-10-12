/**
 * seed-oauth-client.ts
 *
 * Registers an OAuth client in B4M's MongoDB.
 * Run once per product to get a client_id + client_secret.
 *
 * The admin console's OAuth Clients page is the normal way to do this; it shares
 * createOAuthClient with this script. Use the script where no admin user exists yet.
 *
 * Usage (from repo root):
 *   MONGODB_URI=<uri> CLIENT_NAME="My App" REDIRECT_URIS="https://..." \
 *     pnpm --filter @bike4mind/scripts exec tsx src/seed-oauth-client.ts
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
 * which the derived default would never find. FEDERATED_AUDIENCE is optional and
 * defaults to the generated client_id.
 *   FEDERATED_SUBJECT_SOURCE=sub \
 *   FEDERATED_ISSUER="https://<b4m-app-url>" \
 *   [FEDERATED_AUDIENCE="<this client_id>"] \
 *   FEDERATED_JWKS_URI="https://<b4m-app-url>/api/oauth/jwks"
 *
 * REDIRECT_URIS is comma-separated. Each URI must be an absolute https URL; http is
 * allowed only for localhost, 127.0.0.1 and [::1]. No fragment, userinfo or whitespace.
 */

import { ConflictError, type OAuthFederatedIdpInput } from '@bike4mind/common';
import { createOAuthClient, mongoose, OAuthClientModel } from '@bike4mind/database';
import { ZodError } from 'zod';
import { isDirectInvocation } from '../utils/isDirectInvocation.js';

/**
 * Raw federated trust config from env (see the header for the two shapes). The shape rules,
 * including the `sub` audience defaulting to the generated client_id, live in
 * resolveOAuthFederatedIdp so this script and the admin page enforce the same ones.
 */
export function readFederatedIdpEnv(env: NodeJS.ProcessEnv = process.env): OAuthFederatedIdpInput | undefined {
  const rawSubjectSource = env.FEDERATED_SUBJECT_SOURCE || undefined;
  if (rawSubjectSource && rawSubjectSource !== 'identities' && rawSubjectSource !== 'sub') {
    throw new Error(`FEDERATED_SUBJECT_SOURCE must be 'identities' or 'sub', got '${rawSubjectSource}'`);
  }
  const subjectSource = rawSubjectSource as OAuthFederatedIdpInput['subjectSource'];
  const input: OAuthFederatedIdpInput = {
    issuer: env.FEDERATED_ISSUER || undefined,
    audience: env.FEDERATED_AUDIENCE || undefined,
    providerName: env.FEDERATED_PROVIDER_NAME || undefined,
    jwksUri: env.FEDERATED_JWKS_URI || undefined,
    subjectSource,
  };
  return Object.values(input).some(Boolean) ? input : undefined;
}

/**
 * Trust class for the client being registered. External products default to 'relying-party'
 * (scope/audience-bound token, no first-party session). Registering a first-party client - one
 * B4M owns - is the rare case and must be opted into explicitly with CLIENT_TYPE=first-party.
 */
export function resolveClientType(env: NodeJS.ProcessEnv = process.env): 'first-party' | 'relying-party' {
  const raw = env.CLIENT_TYPE;
  if (!raw) return 'relying-party';
  if (raw !== 'first-party' && raw !== 'relying-party') {
    throw new Error(`CLIENT_TYPE must be 'first-party' or 'relying-party', got '${raw}'`);
  }
  return raw;
}

export type SeedResult =
  | { status: 'created'; client: Awaited<ReturnType<typeof createOAuthClient>>['client']; clientSecret: string }
  | { status: 'exists'; name: string; clientId?: string };

/** Registers the client described by env; a duplicate name resolves to 'exists', anything else rejects. */
export async function runSeed(env: NodeJS.ProcessEnv = process.env): Promise<SeedResult> {
  const mongoUri = env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI env var required');

  const clientName = env.CLIENT_NAME;
  if (!clientName) throw new Error('CLIENT_NAME env var required (e.g. "My App")');

  const redirectUrisRaw = env.REDIRECT_URIS;
  if (!redirectUrisRaw) throw new Error('REDIRECT_URIS env var required (comma-separated)');
  const redirectUris = redirectUrisRaw
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);

  const federatedIdpInput = readFederatedIdpEnv(env);
  const clientType = resolveClientType(env);

  await mongoose.connect(mongoUri);
  try {
    const { client, clientSecret } = await createOAuthClient({
      name: clientName,
      redirectUris,
      clientType,
      federatedIdp: federatedIdpInput,
    });
    return { status: 'created', client, clientSecret };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const existing = await OAuthClientModel.findOne({ name: clientName.trim() }).exec();
    return { status: 'exists', name: clientName.trim(), clientId: existing?.clientId };
  } finally {
    await mongoose.disconnect();
  }
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map(issue => `  - ${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('\n');
}

export async function main(): Promise<void> {
  let result: SeedResult;
  try {
    result = await runSeed();
  } catch (err) {
    if (err instanceof ZodError) console.error(`Invalid input:\n${formatZodError(err)}`);
    else console.error(err);
    process.exit(1);
    return;
  }

  if (result.status === 'exists') {
    console.log(`\nClient "${result.name}" already exists:`);
    console.log('  client_id:', result.clientId);
    console.log('\nRotate its secret or edit it from the admin OAuth Clients page instead.\n');
    process.exit(0);
    return;
  }

  const { client, clientSecret } = result;
  const federatedIdp = client.federatedIdp;
  console.log('\n✅ OAuth client registered!\n');
  console.log('  client_id    :', client.clientId);
  console.log('  client_secret:', clientSecret);
  // Surface the trust class explicitly - it defaults to relying-party and set CLIENT_TYPE=first-party
  // to opt in, so an operator can confirm which one this registration got.
  console.log('  client_type  :', client.clientType);
  if (federatedIdp) {
    console.log('  federated    : yes (may mint per-user ai:generate keys via /api/oauth/ai-token)');
    console.log('    issuer      :', federatedIdp.issuer);
    console.log('    audience    :', federatedIdp.audience);
    console.log('    subject from:', federatedIdp.subjectSource ?? 'identities');
    if (federatedIdp.providerName) console.log('    provider    :', federatedIdp.providerName);
    if (federatedIdp.jwksUri) console.log('    jwks uri    :', federatedIdp.jwksUri);
  }
  console.log(`\nSet these SST secrets in ${client.name}:`);
  console.log(`  sst secret set B4mOAuthClientId "${client.clientId}"`);
  console.log('  sst secret set B4mOAuthClientSecret "<the client_secret above>"');
  console.log('\n⚠️  The client_secret will NOT be shown again.\n');
}

// Run only when executed directly (npx tsx ...), not when a test imports main.
if (isDirectInvocation(import.meta.url)) {
  void main();
}
