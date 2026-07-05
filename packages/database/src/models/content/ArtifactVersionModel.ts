import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

// mongoose 8.24 defaults Document's _id to ObjectId; this model keys on a
// string _id, so parametrize Document<string> to keep the interface assignable.
export interface IArtifactVersionDocument extends Document<string> {
  id: string;
  _id: string;
  artifactId: string;
  version: number;
  versionTag?: string;
  contentId: Schema.Types.ObjectId;
  parentVersionId?: Schema.Types.ObjectId;
  changes: string[];
  changeDescription?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

// Artifact Version schema - tracks all versions of an artifact
const ArtifactVersionSchema = new Schema(
  {
    artifactId: {
      type: String,
      required: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
      min: 1,
    },
    versionTag: {
      type: String,
      maxlength: 100,
    },
    contentId: {
      type: Schema.Types.ObjectId,
      ref: 'ArtifactContent',
      required: true,
    },
    parentVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'ArtifactVersion',
    },
    changes: [
      {
        type: String,
        maxlength: 500,
      },
    ],
    changeDescription: {
      type: String,
      maxlength: 1000,
    },
    createdBy: {
      type: String,
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Only track creation time
    collection: 'artifact_versions',
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Compound indexes
ArtifactVersionSchema.index({ artifactId: 1, version: 1 }, { unique: true }); // One version per artifact version number
ArtifactVersionSchema.index({ artifactId: 1, isActive: 1 }); // Current active version
ArtifactVersionSchema.index({ artifactId: 1, createdAt: -1 }); // Version history
ArtifactVersionSchema.index({ createdBy: 1, createdAt: -1 }); // User's versions

// Virtual to populate content
ArtifactVersionSchema.virtual('content', {
  ref: 'ArtifactContent',
  localField: 'contentId',
  foreignField: '_id',
  justOne: true,
});

// Virtual to populate parent version
ArtifactVersionSchema.virtual('parentVersion', {
  ref: 'ArtifactVersion',
  localField: 'parentVersionId',
  foreignField: '_id',
  justOne: true,
});

export const ArtifactVersion =
  (mongoose.models.ArtifactVersion as mongoose.Model<IArtifactVersionDocument>) ||
  model<IArtifactVersionDocument>('ArtifactVersion', ArtifactVersionSchema);

// Repository implementation
export class ArtifactVersionRepository extends BaseRepository<IArtifactVersionDocument> {
  constructor(model: Model<IArtifactVersionDocument>) {
    super(model);
  }

  // Override update method to handle MongoDB _id properly
  async update(
    data: Partial<IArtifactVersionDocument>,
    options?: Record<string, unknown>
  ): Promise<IArtifactVersionDocument | null> {
    if (!data.id && !data._id) {
      throw new Error('id or _id is required');
    }

    const id = data.id || data._id;
    const query = this.model.findByIdAndUpdate(
      id, // This is the MongoDB _id
      { $set: data },
      { new: true, ...options }
    );
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    const result = await query;

    return result?.toJSON() as unknown as IArtifactVersionDocument | null;
  }

  async findByArtifactId(artifactId: string) {
    return this.find({ artifactId }, { sort: { version: -1 } });
  }

  async findActiveVersion(artifactId: string) {
    return this.findOne({ artifactId, isActive: true });
  }

  async findByVersion(artifactId: string, version: number) {
    return this.findOne({ artifactId, version });
  }

  async findByCreator(createdBy: string) {
    return this.find({ createdBy }, { sort: { createdAt: -1 } });
  }

  async getVersionHistory(artifactId: string) {
    return this.find({ artifactId }, { sort: { version: 1 } });
  }

  async setActiveVersion(artifactId: string, version: number) {
    // First, unset all active versions for this artifact
    await this.model.updateMany({ artifactId }, { isActive: false });

    // Then set the specified version as active
    return this.model.updateOne({ artifactId, version }, { isActive: true });
  }

  // Missing methods from interface
  async findByUser(userId: string) {
    return this.find({ createdBy: userId });
  }

  async createVersion(
    artifactId: string,
    version: number,
    contentId: string,
    createdBy: string,
    changes?: string[],
    changeDescription?: string,
    parentVersionId?: string
  ) {
    return this.create({
      artifactId,
      version,
      contentId,
      createdBy,
      changes: changes || [],
      changeDescription,
      parentVersionId,
      isActive: false,
    } as any);
  }

  async createOrUpdate(
    data: Omit<IArtifactVersionDocument, 'id' | '_id' | 'updatedAt' | 'createdAt'>
  ): Promise<IArtifactVersionDocument> {
    const result = await this.model.findOneAndUpdate(
      { artifactId: data.artifactId, version: data.version },
      { $set: data },
      { upsert: true, new: true }
    );
    return result.toJSON() as unknown as IArtifactVersionDocument;
  }

  async getLatestVersion(artifactId: string) {
    const versions = await this.find({ artifactId });
    if (versions.length === 0) return 0;

    return Math.max(...versions.map(v => v.version));
  }
}

export const artifactVersionRepository = new ArtifactVersionRepository(ArtifactVersion);
export default ArtifactVersion;
