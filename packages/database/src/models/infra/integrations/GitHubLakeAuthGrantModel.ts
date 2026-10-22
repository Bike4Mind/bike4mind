import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'GitHubLakeAuthGrant';

/**
 * A GitHub user-to-server token held between the data-lake GitHub authorize callback and the
 * repository pick that completes the connect (githubLakeAuthGrant.ts). Keyed by the hash of the
 * flow's browser-binding nonce cookie, so only the browser that started the flow can use it.
 * `encryptedToken` is tokenEncryption ciphertext; the token itself never reaches the browser.
 */
export interface IGitHubLakeAuthGrantDoc {
  _id: string;
  nonceHash: string;
  userId: string;
  dataLakeId: string;
  encryptedToken: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type GitHubLakeAuthGrantInput = Pick<
  IGitHubLakeAuthGrantDoc,
  'nonceHash' | 'userId' | 'dataLakeId' | 'encryptedToken' | 'expiresAt'
>;

type IGitHubLakeAuthGrantModel = Model<IGitHubLakeAuthGrantDoc>;

const GitHubLakeAuthGrantSchema = new Schema<IGitHubLakeAuthGrantDoc>(
  {
    nonceHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    dataLakeId: { type: String, required: true },
    encryptedToken: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Sweep only: reads still filter on expiresAt, since the TTL monitor runs about once a minute.
GitHubLakeAuthGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GitHubLakeAuthGrant: IGitHubLakeAuthGrantModel =
  (mongoose.models[ModelName] as IGitHubLakeAuthGrantModel) ||
  model<IGitHubLakeAuthGrantDoc, IGitHubLakeAuthGrantModel>(ModelName, GitHubLakeAuthGrantSchema);

export const gitHubLakeAuthGrantRepository = {
  /** Stores the grant for this flow, returning the one it replaced (whose token the caller revokes). */
  async replace(grant: GitHubLakeAuthGrantInput): Promise<IGitHubLakeAuthGrantDoc | null> {
    return GitHubLakeAuthGrant.findOneAndUpdate({ nonceHash: grant.nonceHash }, { $set: grant }, { upsert: true })
      .lean<IGitHubLakeAuthGrantDoc>()
      .exec();
  },

  async findLive(nonceHash: string): Promise<IGitHubLakeAuthGrantDoc | null> {
    return GitHubLakeAuthGrant.findOne({ nonceHash, expiresAt: { $gt: new Date() } })
      .lean<IGitHubLakeAuthGrantDoc>()
      .exec();
  },

  /** Atomic take, so two concurrent completions cannot both consume one grant. */
  async consume(nonceHash: string): Promise<IGitHubLakeAuthGrantDoc | null> {
    return GitHubLakeAuthGrant.findOneAndDelete({ nonceHash }).lean<IGitHubLakeAuthGrantDoc>().exec();
  },
};
