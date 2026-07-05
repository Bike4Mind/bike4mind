import mongoose, { Model, Schema, model } from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

export interface IMetaPromptVersion {
  versionNumber: number;
  content: string;
  isActive: boolean;
  createdAt: Date;
  createdBy: string;
  description: string;
}

export interface IAgentOpsSettings {
  generationLlmModel: string;
  rateLimitSeconds: number;
  isEnabled: boolean;
  totalGenerationsCount: number;
  lastGenerationAt: Date | null;
  versions: IMetaPromptVersion[];
  currentVersionNumber: number;
}

export interface IAgentOpsSettingsDocument extends IAgentOpsSettings, mongoose.Document {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAgentOpsSettingsRepository {
  getSettings(): Promise<IAgentOpsSettingsDocument | null>;
  createOrUpdateSettings(settings: Partial<IAgentOpsSettings>): Promise<IAgentOpsSettingsDocument>;
  addMetaPromptVersion(content: string, createdBy: string, description?: string): Promise<IAgentOpsSettingsDocument>;
  activateMetaPromptVersion(versionNumber: number): Promise<IAgentOpsSettingsDocument>;
  getActiveMetaPrompt(): Promise<IMetaPromptVersion | null>;
  incrementGenerationCount(): Promise<void>;
}

export enum AgentOpsLlmModel {
  // Modern models
  CLAUDE_FABLE_5 = 'claude-fable-5',
  CLAUDE_OPUS_4_8 = 'claude-opus-4-8',
  CLAUDE_OPUS_4_7 = 'claude-opus-4-7',
  CLAUDE_OPUS_4_6 = 'claude-opus-4-6',
  CLAUDE_SONNET_5 = 'claude-sonnet-5',
  CLAUDE_SONNET_4_6 = 'claude-sonnet-4-6',
  CLAUDE_OPUS_4 = 'claude-opus-4-20250514',
  CLAUDE_SONNET_4 = 'claude-sonnet-4-20250514',
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5-20250929',
  CLAUDE_HAIKU_4_5 = 'claude-haiku-4-5-20251001',
  O3 = 'o3-2025-04-16',
  GPT_4_1 = 'gpt-4.1-2025-04-14',
  GROK_3 = 'grok-3',
  GPT_4O = 'gpt-4o',
  GPT_4O_MINI = 'gpt-4o-mini',
  // Deprecated - kept for Mongoose validation of existing DB documents
  GPT_4_TURBO = 'gpt-4-turbo',
  CLAUDE_3_7_SONNET = 'claude-3-7-sonnet-20250219',
  CLAUDE_3_5_SONNET = 'claude-3-5-sonnet-20241022',
  CLAUDE_3_OPUS = 'claude-3-opus-20240229',
  CLAUDE_3_HAIKU = 'claude-3-haiku-20240307',
}

// Meta-prompt version schema
const MetaPromptVersionSchema = new Schema(
  {
    versionNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    content: {
      type: String,
      required: true,
      minlength: 10,
      maxlength: 50000,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    createdBy: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
  },
  {
    _id: false, // Don't create separate _id for subdocuments
  }
);

// AgentOps Settings schema
const AgentOpsSettingsSchema = new Schema(
  {
    generationLlmModel: {
      type: String,
      enum: Object.values(AgentOpsLlmModel),
      required: true,
      default: AgentOpsLlmModel.CLAUDE_OPUS_4_6,
    },
    rateLimitSeconds: {
      type: Number,
      required: true,
      min: 1,
      max: 3600,
      default: 60,
    },
    isEnabled: {
      type: Boolean,
      required: true,
      default: true,
    },
    totalGenerationsCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastGenerationAt: {
      type: Date,
      default: null,
    },
    versions: {
      type: [MetaPromptVersionSchema],
      default: [],
    },
    currentVersionNumber: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  {
    timestamps: true,
  }
);

AgentOpsSettingsSchema.plugin(softDeletePlugin);

class AgentOpsSettingsRepository
  extends BaseRepository<IAgentOpsSettingsDocument>
  implements IAgentOpsSettingsRepository
{
  constructor(model: Model<IAgentOpsSettingsDocument>) {
    super(model);
  }

  async createOrUpdateSettings(settingsData: Partial<IAgentOpsSettings>): Promise<IAgentOpsSettingsDocument> {
    let settings = await this.model.findOne({});

    if (!settings) {
      settings = new this.model(settingsData);
    } else {
      Object.assign(settings, settingsData);
    }

    return await settings.save();
  }

  async getSettings(): Promise<IAgentOpsSettingsDocument | null> {
    return await this.model.findOne({});
  }

  async addMetaPromptVersion(
    content: string,
    createdBy: string,
    description?: string
  ): Promise<IAgentOpsSettingsDocument> {
    let settingsDoc = await this.getSettings();

    if (!settingsDoc) {
      // Auto-create settings if missing
      settingsDoc = await this.createOrUpdateSettings({
        generationLlmModel: AgentOpsLlmModel.CLAUDE_OPUS_4_6,
        rateLimitSeconds: 60,
        isEnabled: true,
        totalGenerationsCount: 0,
        lastGenerationAt: null,
        versions: [],
        currentVersionNumber: 1,
      });
    }

    const existingVersionNumbers = (settingsDoc.versions || [])
      .map((v: IMetaPromptVersion) => v.versionNumber)
      .filter((num: number) => typeof num === 'number' && !isNaN(num));

    const nextVersionNumber = existingVersionNumbers.length > 0 ? Math.max(...existingVersionNumbers) + 1 : 1;

    const newVersion: IMetaPromptVersion = {
      versionNumber: nextVersionNumber,
      content,
      isActive: settingsDoc.versions.length === 0, // Auto-activate first version
      createdAt: new Date(),
      createdBy,
      description: description || `Version ${nextVersionNumber}`,
    };

    settingsDoc.versions.push(newVersion);
    settingsDoc.currentVersionNumber = nextVersionNumber;

    return await settingsDoc.save();
  }

  async activateMetaPromptVersion(versionNumber: number): Promise<IAgentOpsSettingsDocument> {
    const settings = await this.getSettings();
    if (!settings) {
      throw new Error('AgentOps settings not found');
    }

    const version = settings.versions.find((v: IMetaPromptVersion) => v.versionNumber === versionNumber);
    if (!version) {
      throw new Error(`Version ${versionNumber} not found`);
    }

    // Deactivate all versions
    settings.versions.forEach((v: IMetaPromptVersion) => (v.isActive = false));

    // Activate the specified version
    version.isActive = true;
    settings.currentVersionNumber = versionNumber;

    return await settings.save();
  }

  async getActiveMetaPrompt(): Promise<IMetaPromptVersion | null> {
    const settings = await this.getSettings();
    if (!settings || !settings.versions) {
      return null;
    }

    return settings.versions.find((v: IMetaPromptVersion) => v.isActive) || null;
  }

  async incrementGenerationCount(): Promise<void> {
    await this.model.updateOne(
      {},
      {
        $inc: { totalGenerationsCount: 1 },
        $set: { lastGenerationAt: new Date() },
      }
    );
  }
}

// Reuse existing model to avoid overwrite errors on hot reload
const AgentOpsSettings =
  mongoose.models.AgentOpsSettings || model<IAgentOpsSettingsDocument>('AgentOpsSettings', AgentOpsSettingsSchema);

const agentOpsSettingsRepository = new AgentOpsSettingsRepository(AgentOpsSettings);

export { AgentOpsSettings, agentOpsSettingsRepository, AgentOpsSettingsRepository };
