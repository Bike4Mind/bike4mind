import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'SamlRequestId';

/**
 * Ids of outbound SAML AuthnRequests, so an inbound SAMLResponse's `InResponseTo`
 * can be redeemed exactly once (node-saml's replay guard - see the cacheProvider in
 * apps/client/server/auth/samlRequestCache.ts, which is the only consumer).
 *
 * A shared store, not node-saml's default in-memory provider: the API runs on Lambda,
 * so the instance that issued the AuthnRequest is usually not the one that receives
 * the response, and a per-instance cache would reject legitimate logins.
 */
export interface ISamlRequestIdDoc {
  _id: string;
  requestId: string;
  /** The AuthnRequest's IssueInstant, as node-saml stores it. */
  value: string;
  createdAt: Date;
}

interface ISamlRequestIdModel extends Model<ISamlRequestIdDoc> {}

const SamlRequestIdSchema = new Schema<ISamlRequestIdDoc>(
  {
    requestId: { type: String, required: true, unique: true },
    value: { type: String, required: true },
  },
  { timestamps: true }
);

// TTL: an unredeemed request id is dead weight once the login attempt is over.
// One hour comfortably covers a login round trip including IdP re-authentication.
SamlRequestIdSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

export const SamlRequestId: ISamlRequestIdModel =
  (mongoose.models[ModelName] as ISamlRequestIdModel) ||
  model<ISamlRequestIdDoc, ISamlRequestIdModel>(ModelName, SamlRequestIdSchema);
