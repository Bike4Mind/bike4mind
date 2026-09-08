import { IBaseRepository } from './BaseTypes';

export interface IMetaPromptVersion {
  versionNumber: number;
  metaPrompt: string;
  description: string;
  createdBy: string; // User ID of admin who created this version
  createdAt: Date;
  isActive: boolean;
}

export interface IAgentOpsSettings {
  id: string;

  // Meta-prompt versioning
  versions: IMetaPromptVersion[];
  currentVersionNumber: number;

  // Generation settings.
  // A catalog model id, not a closed union: the selectable set is the live model catalog,
  // validated at the agent-ops-settings endpoint. Enumerating ids here would make every newly
  // shipped model a type error, and stored documents may still hold long-retired ids.
  generationLlmModel: string;

  // Rate limiting
  rateLimitSeconds: number; // Minimum seconds between generations per agent

  // Usage tracking
  totalGenerationsCount: number;
  lastGenerationAt: Date | null;

  // Feature flags
  isEnabled: boolean;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export interface IAgentOpsSettingsDocument extends IAgentOpsSettings {}

export interface IAgentOpsSettingsRepository extends IBaseRepository<IAgentOpsSettingsDocument> {
  /**
   * Get the global agent operations settings
   */
  getSettings(): Promise<IAgentOpsSettingsDocument | null>;

  /**
   * Create or update the global agent operations settings
   */
  createOrUpdateSettings(settings: Partial<IAgentOpsSettings>): Promise<IAgentOpsSettingsDocument>;

  /**
   * Add a new meta-prompt version
   */
  addMetaPromptVersion(metaPrompt: string, description: string, createdBy: string): Promise<IAgentOpsSettingsDocument>;

  /**
   * Activate a specific meta-prompt version
   */
  activateMetaPromptVersion(versionNumber: number): Promise<IAgentOpsSettingsDocument>;

  /**
   * Get the currently active meta-prompt
   */
  getActiveMetaPrompt(): Promise<string | null>;
}
