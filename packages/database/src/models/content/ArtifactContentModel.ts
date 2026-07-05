import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

// mongoose 8.24 defaults Document's _id to ObjectId; this model keys on a
// string _id, so parametrize Document<string> to keep the interface assignable.
export interface IArtifactContentDocument extends Document<string> {
  id: string;
  _id: string;
  artifactId: string;
  version: number;
  content: string;
  contentHash: string;
  contentSize: number;
  mimeType?: string;
  encoding?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Artifact Content schema - stores the actual content separately for performance
const ArtifactContentSchema = new Schema(
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
    content: {
      type: String,
      required: true,
    },
    contentHash: {
      type: String,
      required: true,
      // Index defined separately below for better control
    },
    contentSize: {
      type: Number,
      required: true,
      min: 0,
    },
    mimeType: {
      type: String,
      default: 'text/plain',
    },
    encoding: {
      type: String,
      default: 'utf8',
    },
  },
  {
    timestamps: true,
    collection: 'artifact_contents',
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Compound indexes
ArtifactContentSchema.index({ artifactId: 1, version: 1 }, { unique: true }); // One content per artifact version
ArtifactContentSchema.index({ contentHash: 1 }); // Content deduplication
ArtifactContentSchema.index({ createdAt: -1 }); // Recent content

export const ArtifactContent =
  (mongoose.models.ArtifactContent as mongoose.Model<IArtifactContentDocument>) ||
  model<IArtifactContentDocument>('ArtifactContent', ArtifactContentSchema);

// Repository implementation
export class ArtifactContentRepository extends BaseRepository<IArtifactContentDocument> {
  constructor(model: Model<IArtifactContentDocument>) {
    super(model);
  }

  // Override update method to handle MongoDB _id properly
  async update(
    data: Partial<IArtifactContentDocument>,
    options?: Record<string, unknown>
  ): Promise<IArtifactContentDocument | null> {
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

    return result?.toJSON() as unknown as IArtifactContentDocument | null;
  }

  async findByArtifactId(artifactId: string) {
    return this.find({ artifactId });
  }

  async findByArtifactAndVersion(artifactId: string, version: number) {
    return this.findOne({ artifactId, version });
  }

  async findByContentHash(contentHash: string) {
    return this.find({ contentHash });
  }

  async findLatestByArtifact(artifactId: string) {
    const contents = await this.find({ artifactId }, { sort: { version: -1 }, limit: 1 });
    return contents[0] || null;
  }

  async getContentVersions(artifactId: string) {
    return this.find({ artifactId }, { sort: { version: 1 } });
  }

  // Missing methods from interface
  async findByArtifactVersion(artifactId: string, version: number) {
    return this.findOne({ artifactId, version });
  }

  async findByHash(contentHash: string) {
    return this.find({ contentHash });
  }

  async findLatestContent(artifactId: string) {
    // Use database sorting for better performance and accuracy
    const contents = await this.find({ artifactId }, { sort: { version: -1 }, limit: 1 });
    return contents[0] || null;
  }

  async createVersion(artifactId: string, version: number, content: string, contentHash: string) {
    const contentSize = Buffer.byteLength(content, 'utf8');
    return this.create({
      artifactId,
      version,
      content,
      contentHash,
      contentSize,
      mimeType: 'text/plain',
      encoding: 'utf8',
    } as any);
  }

  async createOrUpdate(
    data: Omit<IArtifactContentDocument, 'id' | '_id' | 'updatedAt' | 'createdAt'>
  ): Promise<IArtifactContentDocument> {
    const result = await this.model.findOneAndUpdate(
      { artifactId: data.artifactId, version: data.version },
      { $set: data },
      { upsert: true, new: true }
    );
    return result.toJSON() as unknown as IArtifactContentDocument;
  }

  async getContentSize(artifactId: string, version?: number) {
    const query: any = { artifactId };
    if (version) {
      query.version = version;
    }

    const content = await this.findOne(query);
    return content ? content.contentSize : 0;
  }
}

export const artifactContentRepository = new ArtifactContentRepository(ArtifactContent);
export default ArtifactContent;
