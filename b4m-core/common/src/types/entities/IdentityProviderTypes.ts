import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export interface IIdentityProvider {
  id: string;
  name: string;
  emailDomain: string;
  type: 'saml' | 'okta';
  isActive: boolean;

  // SAML Configuration
  samlConfig?: {
    entryPoint: string;
    issuer: string;
    cert: string;
    callbackUrl?: string;
    decryptionPvk?: string;
    privateCert?: string;
    identifierFormat?: string;
    acceptedClockSkewMs?: number;
    attributeConsumingServiceIndex?: number;
    disableRequestedAuthnContext?: boolean;

    // Attribute mappings
    attributeMappings?: {
      email?: string;
      firstName?: string;
      lastName?: string;
      name?: string;
      username?: string;
    };
  };

  // Okta Configuration (for backwards compatibility)
  oktaConfig?: {
    audience: string;
    clientId: string;
    /**
     * Optional because it is `select: false` at rest: every read except the
     * `*WithSecrets` accessors below resolves it as undefined. Same for
     * samlConfig.decryptionPvk / privateCert above.
     */
    clientSecret?: string;
    /** Authorization server ID (default: 'default') */
    authServerId?: string;
    /** If true, use org-level authorization server (no /oauth2/ path) */
    useOrgAuthServer?: boolean;
  };

  createdAt: Date;
  updatedAt: Date;
  createdBy: string; // User ID who created this IDP
}

export interface IIdentityProviderDocument extends IIdentityProvider, IMongoDocument {}

export interface IIdentityProviderRepository extends IBaseRepository<IIdentityProviderDocument> {
  findByEmailDomain: (domain: string) => Promise<IIdentityProviderDocument | null>;
  findActiveByEmailDomain: (domain: string) => Promise<IIdentityProviderDocument | null>;
  findAll: () => Promise<IIdentityProviderDocument[]>;
  findActiveIDPs: () => Promise<IIdentityProviderDocument[]>;
  /**
   * The login-path reads: the only accessors whose results carry the `select: false`
   * secrets, decrypted. Everything above resolves those fields as undefined, which is
   * what keeps key material out of API responses by construction. Never build a
   * response from these.
   */
  findByIdWithSecrets: (id: string) => Promise<IIdentityProviderDocument | null>;
  findAllWithSecrets: () => Promise<IIdentityProviderDocument[]>;
}

export interface AuthStrategyResponse {
  strategy: 'password' | 'otc' | 'google' | 'github' | 'okta' | 'saml';
  redirectUrl?: string;
  requiresRedirect: boolean;
  identityProvider?: {
    id: string;
    name: string;
    type: string;
  };
  message?: string;
}
