import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { decryptAtRest, encryptAtRest } from '@bike4mind/utils/security';

export interface IIdentityProviderDocument extends Document {
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
    clientSecret: string;
    /** Authorization server ID (default: 'default') */
    authServerId?: string;
    /** If true, use org-level authorization server (no /oauth2/ path) */
    useOrgAuthServer?: boolean;
  };

  createdAt: Date;
  updatedAt: Date;
  createdBy: string; // User ID who created this IDP
}

export interface IIdentityProviderRepository {
  findByEmailDomain: (domain: string) => Promise<IIdentityProviderDocument | null>;
  findActiveByEmailDomain: (domain: string) => Promise<IIdentityProviderDocument | null>;
  findAll: () => Promise<IIdentityProviderDocument[]>;
  findActiveIDPs: () => Promise<IIdentityProviderDocument[]>;
  findByIdWithSecrets: (id: string) => Promise<IIdentityProviderDocument | null>;
  findAllWithSecrets: () => Promise<IIdentityProviderDocument[]>;
  createIDP: (data: Partial<IIdentityProviderDocument>) => Promise<IIdentityProviderDocument>;
  updateIDP: (id: string, data: Partial<IIdentityProviderDocument>) => Promise<IIdentityProviderDocument | null>;
  deleteIDP: (id: string) => Promise<boolean>;
}

/**
 * The IdP fields that are credentials rather than configuration. Encrypted at rest and
 * `select: false` on the schema, so the default read - which is what the admin API
 * serves - carries no key material at all.
 */
const SECRET_SELECT = '+samlConfig.decryptionPvk +samlConfig.privateCert +oktaConfig.clientSecret';

function mapSecrets(
  data: Partial<IIdentityProviderDocument>,
  transform: (value: string) => string
): Partial<IIdentityProviderDocument> {
  const { samlConfig, oktaConfig } = data;
  return {
    ...data,
    ...(samlConfig
      ? {
          samlConfig: {
            ...samlConfig,
            ...(samlConfig.decryptionPvk ? { decryptionPvk: transform(samlConfig.decryptionPvk) } : {}),
            ...(samlConfig.privateCert ? { privateCert: transform(samlConfig.privateCert) } : {}),
          },
        }
      : {}),
    ...(oktaConfig
      ? {
          oktaConfig: {
            ...oktaConfig,
            ...(oktaConfig.clientSecret ? { clientSecret: transform(oktaConfig.clientSecret) } : {}),
          },
        }
      : {}),
  };
}

/**
 * Serialise a hydrated document and decrypt its secrets, for the login reads.
 * `toJSON()` widens to FlattenMaps, hence the two-step cast the write paths also use.
 */
function decryptDoc(doc: { toJSON: () => unknown }): IIdentityProviderDocument {
  return mapSecrets(doc.toJSON() as unknown as IIdentityProviderDocument, decryptAtRest) as IIdentityProviderDocument;
}

/**
 * Drop the secrets from a document on its way back to a caller. Needed on the write
 * paths only: `select: false` already keeps them out of every default read, but a
 * freshly created/updated document still holds the submitted values in memory.
 */
function stripSecrets<T extends Partial<IIdentityProviderDocument>>(doc: T): T {
  const { samlConfig, oktaConfig, ...rest } = doc;
  return {
    ...rest,
    ...(samlConfig ? { samlConfig: { ...samlConfig, decryptionPvk: undefined, privateCert: undefined } } : {}),
    ...(oktaConfig ? { oktaConfig: { ...oktaConfig, clientSecret: undefined } } : {}),
  } as T;
}

const IdentityProviderSchema = new Schema<IIdentityProviderDocument>(
  {
    name: { type: String, required: true },
    emailDomain: { type: String, required: true, unique: true },
    type: { type: String, enum: ['saml', 'okta'], required: true },
    isActive: { type: Boolean, default: true },

    samlConfig: {
      entryPoint: { type: String },
      issuer: { type: String },
      cert: { type: String },
      callbackUrl: { type: String },
      // SP key material: encrypted at rest and select:false, so only the login paths
      // that ask for it (findByIdWithSecrets) ever load it. `cert` above is the IdP's
      // PUBLIC signing certificate and is deliberately not a secret.
      decryptionPvk: { type: String, select: false },
      privateCert: { type: String, select: false },
      identifierFormat: { type: String },
      acceptedClockSkewMs: { type: Number },
      attributeConsumingServiceIndex: { type: Number },
      disableRequestedAuthnContext: { type: Boolean },

      attributeMappings: {
        email: { type: String },
        firstName: { type: String },
        lastName: { type: String },
        name: { type: String },
        username: { type: String },
      },
    },

    oktaConfig: {
      audience: { type: String },
      clientId: { type: String },
      clientSecret: { type: String, select: false },
      authServerId: { type: String },
      useOrgAuthServer: { type: Boolean },
    },

    createdBy: { type: String, required: true },
  },
  {
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
    timestamps: true,
    versionKey: false,
  }
);

// Indexes for performance (emailDomain already has unique index from schema definition)
IdentityProviderSchema.index({ emailDomain: 1, isActive: 1 });
IdentityProviderSchema.index({ type: 1, isActive: 1 });

class IdentityProviderRepository
  extends BaseRepository<IIdentityProviderDocument>
  implements IIdentityProviderRepository
{
  constructor() {
    super(IdentityProviderModel);
  }

  async findByEmailDomain(domain: string): Promise<IIdentityProviderDocument | null> {
    return this.model.findOne({ emailDomain: domain.toLowerCase() });
  }

  async findActiveByEmailDomain(domain: string): Promise<IIdentityProviderDocument | null> {
    return this.model.findOne({
      emailDomain: domain.toLowerCase(),
      isActive: true,
    });
  }

  async findAll(): Promise<IIdentityProviderDocument[]> {
    return this.model.find({}).sort({ createdAt: -1 });
  }

  async findActiveIDPs(): Promise<IIdentityProviderDocument[]> {
    return this.model.find({ isActive: true }).sort({ emailDomain: 1 });
  }

  /**
   * The login-path read: loads the encrypted fields and returns them decrypted, for the
   * SAML strategy setup and the Okta token exchange. Never use it to build an API
   * response - use `findById`, which cannot carry the secrets at all.
   */
  async findByIdWithSecrets(id: string): Promise<IIdentityProviderDocument | null> {
    const doc = await this.model.findById(id).select(SECRET_SELECT);
    if (!doc) return null;
    return decryptDoc(doc);
  }

  /** `findAll` counterpart for the login paths (see findByIdWithSecrets). */
  async findAllWithSecrets(): Promise<IIdentityProviderDocument[]> {
    const docs = await this.model.find({}).select(SECRET_SELECT).sort({ createdAt: -1 });
    return docs.map(decryptDoc);
  }

  async createIDP(data: Partial<IIdentityProviderDocument>): Promise<IIdentityProviderDocument> {
    if (data.emailDomain) {
      data.emailDomain = data.emailDomain.toLowerCase();
    }
    const result = await this.model.create(mapSecrets(data, encryptAtRest));
    return stripSecrets(result.toJSON() as unknown as IIdentityProviderDocument);
  }

  async updateIDP(id: string, data: Partial<IIdentityProviderDocument>): Promise<IIdentityProviderDocument | null> {
    if (data.emailDomain) {
      data.emailDomain = data.emailDomain.toLowerCase();
    }

    // findByIdAndUpdate replaces a nested config object wholesale, and the admin API
    // never hands the secrets back out - so an ordinary edit round trip submits a config
    // with the secret fields missing. Carry the stored values forward instead of wiping
    // the IdP's key material; a caller that genuinely wants to replace one sends it.
    let next = data;
    if (data.samlConfig || data.oktaConfig) {
      const current = await this.findByIdWithSecrets(id);
      next = {
        ...data,
        ...(data.samlConfig
          ? {
              samlConfig: {
                ...data.samlConfig,
                decryptionPvk: data.samlConfig.decryptionPvk || current?.samlConfig?.decryptionPvk,
                privateCert: data.samlConfig.privateCert || current?.samlConfig?.privateCert,
              },
            }
          : {}),
        ...(data.oktaConfig
          ? {
              oktaConfig: {
                ...data.oktaConfig,
                // '' only when there is no secret on either side, which is the same
                // "not configured" the truthiness checks downstream already handle.
                clientSecret: data.oktaConfig.clientSecret || current?.oktaConfig?.clientSecret || '',
              },
            }
          : {}),
      };
    }

    const result = await this.model.findByIdAndUpdate(id, mapSecrets(next, encryptAtRest), { new: true });
    return result ? stripSecrets(result.toJSON() as unknown as IIdentityProviderDocument) : null;
  }

  async deleteIDP(id: string): Promise<boolean> {
    const result = await this.model.findByIdAndDelete(id);
    return !!result;
  }
}

export const IdentityProviderModel: Model<IIdentityProviderDocument> =
  (mongoose.models.IdentityProvider as unknown as Model<IIdentityProviderDocument>) ??
  model<IIdentityProviderDocument>('IdentityProvider', IdentityProviderSchema);

export const identityProviderRepository = new IdentityProviderRepository();
