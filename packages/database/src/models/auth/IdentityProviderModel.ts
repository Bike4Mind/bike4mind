import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

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
  createIDP: (data: Partial<IIdentityProviderDocument>) => Promise<IIdentityProviderDocument>;
  updateIDP: (id: string, data: Partial<IIdentityProviderDocument>) => Promise<IIdentityProviderDocument | null>;
  deleteIDP: (id: string) => Promise<boolean>;
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
      decryptionPvk: { type: String },
      privateCert: { type: String },
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
      clientSecret: { type: String },
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

  async createIDP(data: Partial<IIdentityProviderDocument>): Promise<IIdentityProviderDocument> {
    if (data.emailDomain) {
      data.emailDomain = data.emailDomain.toLowerCase();
    }
    const result = await this.model.create(data);
    return result.toJSON() as unknown as IIdentityProviderDocument;
  }

  async updateIDP(id: string, data: Partial<IIdentityProviderDocument>): Promise<IIdentityProviderDocument | null> {
    if (data.emailDomain) {
      data.emailDomain = data.emailDomain.toLowerCase();
    }
    const result = await this.model.findByIdAndUpdate(id, data, { new: true });
    return result?.toJSON() as unknown as IIdentityProviderDocument | null;
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
