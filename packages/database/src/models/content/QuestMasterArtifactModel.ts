import mongoose, { Schema, model, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { USE_DOCUMENTDB } from '../../utils/documentdb-compat';
import { softDeletePlugin } from '../../utils/mongo';

// Interface for individual quest within QuestMaster
export interface IQuestDocument {
  id: string;
  title: string;
  description: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'blocked';
  order: number;
  dependencies: string[];
  estimatedTime?: string;
  completedAt?: Date;
  startedAt?: Date;
}

// Interface for quest resources
export interface IQuestResourceDocument {
  title: string;
  url: string;
  type: 'documentation' | 'tutorial' | 'reference' | 'example';
}

// Interface for QuestMaster content
export interface IQuestMasterContentDocument {
  goal: string;
  quests: IQuestDocument[];
  complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  estimatedTotalTime?: string;
  prerequisites: string[];
  resources: IQuestResourceDocument[];
  progressMetrics: {
    totalQuests: number;
    completedQuests: number;
    estimatedTimeRemaining?: string;
  };
}

// Interface for the QuestMaster artifact document
// mongoose 8.24 defaults Document's _id to ObjectId; this model keys on a
// string _id, so parametrize Document<string> to keep the interface assignable.
export interface IQuestMasterArtifactDocument extends Document<string> {
  _id: string;
  id: string;
  type: 'questmaster';
  title: string;
  description?: string;

  // Versioning
  version: number;
  versionTag?: string;
  currentVersionId: Schema.Types.ObjectId;
  parentVersionId?: Schema.Types.ObjectId;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  deletedAt?: Date;

  // Ownership & Access
  userId: string;
  projectId?: string;
  organizationId?: string;
  visibility: 'private' | 'project' | 'organization' | 'public';
  permissions: {
    canRead: string[];
    canWrite: string[];
    canDelete: string[];
    isPublic: boolean;
    inheritFromProject: boolean;
  };

  // Relationships
  sourceQuestId?: string;
  sessionId?: string;
  parentArtifactId?: string;

  // Status
  status: 'draft' | 'review' | 'published' | 'archived' | 'deleted';
  tags: string[];

  // Content specific to QuestMaster
  content: IQuestMasterContentDocument;

  // Metadata
  contentHash: string;
  contentSize: number;
  metadata: any;
}

// Quest sub-schema
const QuestSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, maxlength: 255 },
    description: { type: String, maxlength: 1000 },
    status: {
      type: String,
      enum: ['not_started', 'in_progress', 'completed', 'blocked'],
      default: 'not_started',
    },
    order: { type: Number, required: true, min: 0 },
    dependencies: [{ type: String }],
    estimatedTime: { type: String },
    completedAt: { type: Date },
    startedAt: { type: Date },
  },
  { _id: false }
);

// Quest Resource sub-schema
const QuestResourceSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 255 },
    url: { type: String, required: true },
    type: {
      type: String,
      enum: ['documentation', 'tutorial', 'reference', 'example'],
      required: true,
    },
  },
  { _id: false }
);

// QuestMaster Content sub-schema
const QuestMasterContentSchema = new Schema(
  {
    goal: { type: String, required: true, maxlength: 1000 },
    quests: [QuestSchema],
    complexity: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced', 'expert'],
      required: true,
    },
    estimatedTotalTime: { type: String },
    prerequisites: [{ type: String, maxlength: 200 }],
    resources: [QuestResourceSchema],
    progressMetrics: {
      totalQuests: { type: Number, required: true, min: 0 },
      completedQuests: { type: Number, required: true, min: 0 },
      estimatedTimeRemaining: { type: String },
    },
  },
  { _id: false }
);

// Permissions sub-schema
const QuestMasterPermissionsSchema = new Schema(
  {
    canRead: [{ type: String, required: true }],
    canWrite: [{ type: String, required: true }],
    canDelete: [{ type: String, required: true }],
    isPublic: { type: Boolean, default: false },
    inheritFromProject: { type: Boolean, default: true },
  },
  { _id: false }
);

// Main QuestMaster Artifact schema
const QuestMasterArtifactSchema = new Schema(
  {
    // Core identification
    id: {
      type: String,
      required: true,
      unique: true,
    },
    type: {
      type: String,
      required: true,
      default: 'questmaster',
    },
    title: {
      type: String,
      required: true,
      maxlength: 255,
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
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    publishedAt: {
      type: Date,
    },
    deletedAt: {
      type: Date,
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
    },
    permissions: {
      type: QuestMasterPermissionsSchema,
      required: true,
    },

    // Relationships
    sourceQuestId: {
      type: String,
    },
    sessionId: {
      type: String,
    },
    parentArtifactId: {
      type: String,
    },

    // Status
    status: {
      type: String,
      enum: ['draft', 'review', 'published', 'archived', 'deleted'],
      default: 'draft',
    },
    tags: [
      {
        type: String,
        maxlength: 50,
      },
    ],

    // QuestMaster-specific content
    content: {
      type: QuestMasterContentSchema,
      required: true,
    },

    // Content metadata
    contentHash: {
      type: String,
      required: true,
    },
    contentSize: {
      type: Number,
      required: true,
      min: 0,
    },

    // Flexible metadata
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: 'questmaster_artifacts',
  }
);

// Indexes for QuestMaster-specific queries
QuestMasterArtifactSchema.index({ userId: 1, status: 1 });
QuestMasterArtifactSchema.index({ projectId: 1, status: 1 });
QuestMasterArtifactSchema.index({ 'content.complexity': 1, status: 1 });
QuestMasterArtifactSchema.index({ 'content.progressMetrics.completedQuests': 1 });
QuestMasterArtifactSchema.index({ sessionId: 1, createdAt: -1 });
QuestMasterArtifactSchema.index({ tags: 1, status: 1 });
// deletedAt index is created by softDeletePlugin - do not add duplicate here

// Apply soft delete plugin for data safety (consistent with QuestMasterPlanModel)
QuestMasterArtifactSchema.plugin(softDeletePlugin);

// Text search for QuestMaster content
// DocumentDB has a limitation of maximum 3 weights in compound text indexes
// while MongoDB allows more. We use conditional logic to support both.

if (USE_DOCUMENTDB()) {
  // DocumentDB-compatible version: Use only top 3 most important fields
  QuestMasterArtifactSchema.index(
    {
      title: 'text',
      'content.goal': 'text',
      'content.quests.title': 'text',
    },
    {
      weights: {
        title: 10,
        'content.goal': 8,
        'content.quests.title': 6,
      },
      name: 'questmaster_text_search',
    }
  );
} else {
  // MongoDB full-featured version: Use all 5 fields with weights
  QuestMasterArtifactSchema.index(
    {
      title: 'text',
      description: 'text',
      'content.goal': 'text',
      'content.quests.title': 'text',
      'content.quests.description': 'text',
    },
    {
      weights: {
        title: 10,
        'content.goal': 8,
        'content.quests.title': 6,
        description: 5,
        'content.quests.description': 3,
      },
      name: 'questmaster_text_search',
    }
  );
}

// Pre-save middleware to update progress metrics
QuestMasterArtifactSchema.pre('save', function (next) {
  if (this.isModified('content.quests')) {
    const totalQuests = this.content.quests.length;
    const completedQuests = this.content.quests.filter(q => q.status === 'completed').length;

    this.content.progressMetrics = {
      totalQuests,
      completedQuests,
      estimatedTimeRemaining: this.content.estimatedTotalTime, // Could calculate based on remaining quests
    };
  }

  if (this.isModified() && !this.isNew) {
    this.updatedAt = new Date();
  }
  next();
});

// Virtual for completion percentage
QuestMasterArtifactSchema.virtual('completionPercentage').get(function () {
  const progressMetrics = this.content?.progressMetrics;
  if (!progressMetrics) return 0;
  const { totalQuests, completedQuests } = progressMetrics;
  return totalQuests > 0 ? (completedQuests / totalQuests) * 100 : 0;
});

// Virtual for next available quest
QuestMasterArtifactSchema.virtual('nextQuest').get(function () {
  return this.content.quests
    .filter(q => q.status === 'not_started')
    .find(q => q.dependencies.every(dep => this.content.quests.find(dq => dq.id === dep)?.status === 'completed'));
});

export const QuestMasterArtifact =
  (mongoose.models.QuestMasterArtifact as mongoose.Model<IQuestMasterArtifactDocument>) ||
  model<IQuestMasterArtifactDocument>('QuestMasterArtifact', QuestMasterArtifactSchema);

export class QuestMasterArtifactRepository extends BaseRepository<IQuestMasterArtifactDocument> {
  // Add shareable property required by interface
  public shareable: any = {}; // Placeholder for IShareableStaticMethods

  constructor(model: Model<IQuestMasterArtifactDocument>) {
    super(model);
  }

  // QuestMaster-specific methods
  async findByComplexity(complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert') {
    return this.find({ 'content.complexity': complexity });
  }

  async findByProgress(minCompletion: number, maxCompletion?: number) {
    // This would need more complex aggregation logic
    return this.find({});
  }

  async findWithAvailableQuests(userId: string) {
    return this.find({ userId });
  }

  async updateQuestStatus(
    artifactId: string,
    questId: string,
    status: 'not_started' | 'in_progress' | 'completed' | 'blocked'
  ) {
    // Implementation would update specific quest status
    return true;
  }

  async completeQuest(artifactId: string, questId: string) {
    return this.updateQuestStatus(artifactId, questId, 'completed');
  }

  async getNextAvailableQuest(artifactId: string) {
    // Implementation would find next available quest
    return null;
  }

  async calculateProgress(artifactId: string) {
    const artifact = await this.findById(artifactId);
    if (!artifact) {
      return { totalQuests: 0, completedQuests: 0, percentage: 0 };
    }

    const totalQuests = artifact.content.quests.length;
    const completedQuests = artifact.content.quests.filter((q: IQuestDocument) => q.status === 'completed').length;
    const percentage = totalQuests > 0 ? Math.round((completedQuests / totalQuests) * 100) : 0;

    return { totalQuests, completedQuests, percentage };
  }

  async searchByQuestContent(searchTerm: string) {
    // Implementation would search quest content
    return this.find({});
  }

  async findByTags(tags: string[]) {
    return this.find({ tags: { $in: tags } });
  }
}

export const questMasterArtifactRepository = new QuestMasterArtifactRepository(QuestMasterArtifact);
export default QuestMasterArtifact;
