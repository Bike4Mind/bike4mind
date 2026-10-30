import * as z from 'zod';
import type { IIdentityProvider } from '../types/entities/IdentityProviderTypes';
import { passthroughShape } from './responseShape';

type SamlConfig = NonNullable<IIdentityProvider['samlConfig']>;
type OktaConfig = NonNullable<IIdentityProvider['oktaConfig']>;

/**
 * Credential fields of an identity provider, never sent to a client: the SP decryption key and
 * signing cert, and the Okta client secret. They are encrypted at rest and select:false, so the
 * repository already omits them; the schema keeps that true if a read path ever changes.
 */
export const IDENTITY_PROVIDER_SAML_WITHHELD_FIELDS = ['decryptionPvk', 'privateCert'] as const;
export const IDENTITY_PROVIDER_OKTA_WITHHELD_FIELDS = ['clientSecret'] as const;

// Held to the config shapes: a new field fails the build here until it is classified.
const SAML_CONFIG_RESPONSE_FIELDS = {
  entryPoint: true,
  issuer: true,
  cert: true,
  callbackUrl: true,
  identifierFormat: true,
  acceptedClockSkewMs: true,
  attributeConsumingServiceIndex: true,
  disableRequestedAuthnContext: true,
  attributeMappings: true,
} as const satisfies Record<Exclude<keyof SamlConfig, (typeof IDENTITY_PROVIDER_SAML_WITHHELD_FIELDS)[number]>, true>;

const OKTA_CONFIG_RESPONSE_FIELDS = {
  audience: true,
  clientId: true,
  authServerId: true,
  useOrgAuthServer: true,
} as const satisfies Record<Exclude<keyof OktaConfig, (typeof IDENTITY_PROVIDER_OKTA_WITHHELD_FIELDS)[number]>, true>;

// `samlConfig` and `oktaConfig` are listed for the key check but replaced below, so their secrets
// are stripped one level down rather than passed through with the parent.
const IDENTITY_PROVIDER_RESPONSE_FIELDS = {
  id: true,
  name: true,
  emailDomain: true,
  type: true,
  isActive: true,
  samlConfig: true,
  oktaConfig: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
} as const satisfies Record<keyof IIdentityProvider, true>;

/** An identity provider as the admin routes return it: configuration only, no credential values. */
export const identityProviderResponseSchema = z.object({
  ...passthroughShape(IDENTITY_PROVIDER_RESPONSE_FIELDS),
  samlConfig: z.object(passthroughShape(SAML_CONFIG_RESPONSE_FIELDS)).nullish(),
  oktaConfig: z.object(passthroughShape(OKTA_CONFIG_RESPONSE_FIELDS)).nullish(),
});

/**
 * Which credentials an identity provider has stored: flags, never values. The single source for
 * the repository that computes them and the admin UI that reads them.
 */
export const identityProviderSecretPresenceSchema = z.object({
  decryptionPvk: z.boolean(),
  privateCert: z.boolean(),
  clientSecret: z.boolean(),
});

export type IdentityProviderSecretPresence = z.infer<typeof identityProviderSecretPresenceSchema>;

/** The admin list row: the provider plus which credentials are stored. */
export const identityProviderListItemResponseSchema = identityProviderResponseSchema.extend({
  hasSecrets: identityProviderSecretPresenceSchema,
});

export const identityProviderListResponseSchema = z.array(identityProviderListItemResponseSchema);
