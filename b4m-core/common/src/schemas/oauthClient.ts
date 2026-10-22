import { z } from 'zod';

export const OAUTH_CLIENT_TYPES = ['first-party', 'relying-party'] as const;
export type OAuthClientType = (typeof OAUTH_CLIENT_TYPES)[number];

export const OAUTH_FEDERATED_SUBJECT_SOURCES = ['identities', 'sub'] as const;

/**
 * Redirect URIs are exact-match strings at /api/oauth/code and /api/oauth/token, which accept any
 * absolute URL. Registration narrows that to https (http only for loopback hosts) so a
 * `javascript:`/`data:` URI can never be a redirect target, and forbids a fragment (RFC 6749 3.1.2)
 * and embedded credentials.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const redirectUriBaseSchema = z
  .string()
  .trim()
  .min(1, 'Redirect URI is required')
  .max(2048, 'Redirect URI is too long');

export const oauthRedirectUriSchema = redirectUriBaseSchema
  .refine(value => {
    try {
      const url = new URL(value);
      if (!url.hostname) return false;
      return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname));
    } catch {
      return false;
    }
  }, 'Redirect URI must be an absolute https URL (http is allowed only for localhost)')
  .refine(value => {
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return true;
    }
  }, 'Redirect URI must not contain credentials')
  .refine(value => !value.includes('#'), 'Redirect URI must not contain a fragment')
  // new URL() strips tabs/newlines, so the parsed host can look fine while the stored string never exact-matches.
  .refine(value => !/\s/.test(value), 'Redirect URI must not contain whitespace');

const httpsUrlSchema = z
  .string()
  .trim()
  .refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname;
    } catch {
      return false;
    }
  }, 'Must be an absolute https URL');

/**
 * Raw federated trust config as an operator enters it. `resolveOAuthFederatedIdp` applies the
 * shape rules, because the `sub` shape's default audience is the client_id, which only exists
 * once the client is being created.
 */
export const oauthFederatedIdpInputSchema = z.object({
  issuer: httpsUrlSchema.optional(),
  audience: z.string().trim().min(1).optional(),
  providerName: z.string().trim().min(1).optional(),
  jwksUri: httpsUrlSchema.optional(),
  subjectSource: z.enum(OAUTH_FEDERATED_SUBJECT_SOURCES).optional(),
});

export type OAuthFederatedIdpInput = z.infer<typeof oauthFederatedIdpInputSchema>;

/** Mirrors IOAuthClientFederatedIdp in packages/database (OAuthClientModel.ts). */
export interface OAuthFederatedIdpConfig {
  issuer: string;
  audience: string;
  jwksUri?: string;
  providerName?: string;
  subjectSource?: 'identities' | 'sub';
}

/**
 * Turns operator input into the stored trust config, or undefined for an ordinary client. Two
 * shapes (see OAuthClientModel.ts): `sub` needs issuer + an explicit jwksUri and defaults the
 * audience to the client_id; the default `identities` shape needs issuer, audience and
 * providerName together. Returns undefined only when no federated input was given at all; a
 * supplied object is federation intent, so a missing piece throws an Error naming it.
 */
export function resolveOAuthFederatedIdp(
  input: OAuthFederatedIdpInput | undefined,
  clientId: string
): OAuthFederatedIdpConfig | undefined {
  if (!input) return undefined;
  const { issuer, audience, providerName, jwksUri, subjectSource } = input;

  if (subjectSource === 'sub') {
    if (!issuer) throw new Error("Federated subject source 'sub' requires an issuer");
    if (!jwksUri) {
      throw new Error(
        "Federated subject source 'sub' requires an explicit JWKS URI: B4M publishes its JWKS at " +
          '<issuer>/api/oauth/jwks, and the derived /.well-known/jwks.json default would 404'
      );
    }
    return { issuer, audience: audience || clientId, jwksUri, subjectSource };
  }

  if (!issuer || !audience || !providerName) {
    throw new Error('A federated client requires issuer, audience, and provider name together');
  }

  // subjectSource stays absent here: absent already means 'identities' for every stored client.
  return { issuer, audience, providerName, ...(jwksUri ? { jwksUri } : {}) };
}

const redirectUrisList = <T extends z.ZodType<string>>(item: T) =>
  z
    .array(item)
    .min(1, 'At least one redirect URI is required')
    .max(20, 'Too many redirect URIs')
    .refine(uris => new Set(uris).size === uris.length, 'Redirect URIs must be unique');

const redirectUrisSchema = redirectUrisList(oauthRedirectUriSchema);

// Update keeps URIs a legacy client already stores, so only the shape is checked here;
// updateOAuthClient applies oauthRedirectUriSchema to the newly-added ones.
const storedRedirectUriSchema = redirectUriBaseSchema;

/**
 * Create payload. `clientType` defaults to the non-privileged relying-party class; first-party is
 * an explicit opt-in (same rule as resolveClientType in seed-oauth-client.ts).
 */
export const createOAuthClientSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
    redirectUris: redirectUrisSchema,
    clientType: z.enum(OAUTH_CLIENT_TYPES).default('relying-party'),
    federatedIdp: oauthFederatedIdpInputSchema.optional(),
  })
  .strict();

/** Update payload: name, type and trust config are fixed at registration. */
export const updateOAuthClientSchema = z
  .object({
    redirectUris: redirectUrisList(storedRedirectUriSchema).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(data => data.redirectUris !== undefined || data.isActive !== undefined, 'Nothing to update');

export type CreateOAuthClientInput = z.input<typeof createOAuthClientSchema>;
export type UpdateOAuthClientInput = z.infer<typeof updateOAuthClientSchema>;

/** What the admin API returns for a client. Never carries the secret or its hash. */
export interface OAuthClientView {
  id: string;
  clientId: string;
  name: string;
  clientType: OAuthClientType;
  tokenEndpointAuthMethod: 'none' | 'client_secret_post';
  redirectUris: string[];
  allowedScopes: string[];
  isActive: boolean;
  federatedIdp?: OAuthFederatedIdpConfig;
  // Null for legacy documents written before timestamps were enabled.
  createdAt: string | null;
  updatedAt: string | null;
}

/** Create and rotate responses: the only place the plaintext secret ever appears. */
export interface OAuthClientWithSecret {
  client: OAuthClientView;
  clientSecret: string;
}
