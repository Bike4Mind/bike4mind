import mongoose, { Schema, model, Document, Model } from 'mongoose';
import { BaseArtifact, ArtifactTypeSchema } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

// Mongoose document interface - omit 'id' from BaseArtifact to avoid conflict with Document._id
export interface IArtifactDocument extends Omit<BaseArtifact, 'id'>, Document {
  id: string; // Custom id field
  softDelete(): Promise<IArtifactDocument>;
  restore(): Promise<IArtifactDocument>;
}

// Permissions sub-schema
const ArtifactPermissionsSchema = new Schema(
  {
    canRead: [{ type: String, required: true }],
    canWrite: [{ type: String, required: true }],
    canDelete: [{ type: String, required: true }],
    isPublic: { type: Boolean, default: false },
    inheritFromProject: { type: Boolean, default: true },
  },
  { _id: false }
);

// Main Artifact schema
const ArtifactSchema = new Schema(
  {
    // Core identification
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ArtifactTypeSchema.options,
    },
    title: {
      type: String,
      required: true,
      maxlength: 255,
      index: true, // For search
    },
    description: {
      type: String,
      maxlength: 1000,
    },

    // Versioning
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    versionTag: {
      type: String,
      maxlength: 100,
    },
    currentVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'ArtifactVersion',
    },
    parentVersionId: {
      type: Schema.Types.ObjectId,
      ref: 'ArtifactVersion',
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    publishedAt: {
      type: Date,
      index: true,
    },
    deletedAt: {
      type: Date,
      // Index defined separately below to avoid duplication warning
    },

    // Ownership & Access
    userId: {
      type: String,
      required: true,
    },
    projectId: {
      type: String,
    },
    organizationId: {
      type: String,
    },
    visibility: {
      type: String,
      enum: ['private', 'project', 'organization', 'public'],
      default: 'private',
      index: true,
    },
    permissions: {
      type: ArtifactPermissionsSchema,
      required: true,
    },

    // Relationships
    sourceQuestId: {
      type: String,
      index: true,
    },
    sessionId: {
      type: String,
    },
    parentArtifactId: {
      type: String,
      index: true,
    },

    // Status
    status: {
      type: String,
      enum: ['draft', 'review', 'published', 'archived', 'deleted'],
      default: 'draft',
      index: true,
    },
    tags: [
      {
        type: String,
        maxlength: 50,
      },
    ],

    // Content metadata
    contentId: {
      type: Schema.Types.ObjectId,
      ref: 'ArtifactContent',
      required: true,
    },
    contentHash: {
      type: String,
      required: true,
      // Index defined separately below to avoid duplication warning
    },
    contentSize: {
      type: Number,
      required: true,
      min: 0,
    },

    // Artifact-specific metadata (stored as flexible object)
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true, // Automatically manages createdAt and updatedAt
    collection: 'artifacts',
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Compound indexes for common queries
ArtifactSchema.index({ userId: 1, status: 1 }); // User's artifacts by status
ArtifactSchema.index({ userId: 1, type: 1 }); // User's artifacts by type
ArtifactSchema.index({ projectId: 1, status: 1 }); // Project artifacts by status
ArtifactSchema.index({ organizationId: 1, visibility: 1 }); // Org artifacts by visibility
ArtifactSchema.index({ type: 1, status: 1, visibility: 1 }); // Public artifacts by type
ArtifactSchema.index({ sessionId: 1, createdAt: -1 }); // Session artifacts chronologically
ArtifactSchema.index({ tags: 1, status: 1 }); // Tag-based discovery
ArtifactSchema.index({ createdAt: -1, status: 1 }); // Recent artifacts
ArtifactSchema.index({ updatedAt: -1, status: 1 }); // Recently updated
ArtifactSchema.index({ contentHash: 1 }); // Content deduplication
ArtifactSchema.index({ deletedAt: 1 }); // Soft delete queries

// Text search index for title and description
ArtifactSchema.index(
  {
    title: 'text',
    description: 'text',
  },
  {
    weights: {
      title: 10,
      description: 5,
    },
    name: 'artifact_text_search',
  }
);

// Pre-save middleware to update timestamps
ArtifactSchema.pre('save', function (next) {
  if (this.isModified() && !this.isNew) {
    this.updatedAt = new Date();
  }
  next();
});

// Pre-update middleware
ArtifactSchema.pre(['updateOne', 'findOneAndUpdate'], function (next) {
  this.set({ updatedAt: new Date() });
  next();
});

// Virtual for checking if artifact is deleted
ArtifactSchema.virtual('isDeleted').get(function () {
  return this.deletedAt != null;
});

// Virtual for checking if artifact is public
ArtifactSchema.virtual('isPublic').get(function () {
  return this.visibility === 'public' || this.permissions.isPublic;
});

// Method to soft delete
ArtifactSchema.methods.softDelete = function () {
  this.deletedAt = new Date();
  this.status = 'deleted';
  return this.save();
};

// Method to restore from soft delete
ArtifactSchema.methods.restore = function () {
  this.deletedAt = undefined;
  if (this.status === 'deleted') {
    this.status = 'draft';
  }
  return this.save();
};

export const Artifact =
  (mongoose.models.Artifact as mongoose.Model<IArtifactDocument>) ||
  model<IArtifactDocument>('Artifact', ArtifactSchema);

// Repository implementation
export class ArtifactRepository extends BaseRepository<IArtifactDocument> {
  // Add shareable property required by interface
  public shareable: any = {}; // Placeholder for IShareableStaticMethods

  constructor(model: Model<IArtifactDocument>) {
    super(model);
  }

  // Override update method to handle custom id field
  async update(data: Partial<IArtifactDocument>, options?: Record<string, unknown>): Promise<IArtifactDocument | null> {
    if (!data.id) {
      throw new Error('id is required');
    }

    // Find by custom id field, not MongoDB _id
    const query = this.model.findOneAndUpdate(
      {
        id: data.id,
      },
      { $set: data },
      { new: true, ...options }
    );
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    const result = await query;

    return result?.toJSON() as unknown as IArtifactDocument | null;
  }

  // Implement artifact-specific methods
  async findByType(type: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, type, deletedAt: null });
  }

  async findByUser(userId: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, userId, deletedAt: null });
  }

  async findByProject(projectId: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, projectId, deletedAt: null });
  }

  async findBySession(sessionId: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, sessionId, deletedAt: null });
  }

  async findActive(filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, deletedAt: null });
  }

  async findByStatus(status: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, status, deletedAt: null });
  }

  async findByVisibility(visibility: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, visibility, deletedAt: null });
  }

  async searchByText(searchTerm: string, filter: Record<string, unknown> = {}) {
    return this.find({
      ...filter,
      deletedAt: null,
      $text: { $search: searchTerm },
    });
  }

  async findDuplicatesByHash(contentHash: string) {
    return this.find({ contentHash, deletedAt: null });
  }

  async findByUserWithAccess(userId: string, accessType: 'read' | 'write' | 'delete' = 'read') {
    const accessField = `permissions.can${accessType.charAt(0).toUpperCase() + accessType.slice(1)}`;
    return this.findActive({
      $or: [{ userId }, { [accessField]: userId }, { visibility: 'public' }, { 'permissions.isPublic': true }],
    });
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.update({
      id,
      deletedAt: new Date(),
      status: 'deleted',
      updatedAt: new Date(),
    } as any);
    return !!result;
  }

  async restore(id: string): Promise<boolean> {
    const result = await this.update({
      id,
      deletedAt: null,
      status: 'draft',
      updatedAt: new Date(),
    } as any);
    return !!result;
  }

  async findDeleted(filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, deletedAt: { $ne: null } });
  }
}

export const artifactRepository = new ArtifactRepository(Artifact);
export default Artifact;
