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

  // Generation settings
  generationLlmModel:
    | 'claude-opus-4-8'
    | 'claude-opus-4-7'
    | 'claude-opus-4-6'
    | 'claude-sonnet-5'
    | 'claude-sonnet-4-6'
    | 'claude-opus-4-20250514'
    | 'claude-sonnet-4-5-20250929'
    | 'claude-haiku-4-5-20251001'
    | 'o3-2025-04-16'
    | 'gpt-4.1-2025-04-14'
    | 'grok-3'
    | 'gpt-4o'
    | 'gpt-4o-mini'
    // Deprecated - kept for backward compat with existing DB documents
    | 'claude-sonnet-4-20250514'
    | 'gpt-4-turbo'
    | 'claude-3-7-sonnet-20250219'
    | 'claude-3-5-sonnet-20241022'
    | 'claude-3-opus-20240229'
    | 'claude-3-haiku-20240307';

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
