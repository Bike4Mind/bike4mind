import { IMongoDocument } from '.';

/**
 * Admin System Prompt - Configurable system prompts managed via the Admin Panel
 *
 * Named "IAdminSystemPrompt" to distinguish from ISystemPrompt in ProjectTypes.ts
 * (which is a simple { fileId, enabled } reference for project-scoped file prompts).
 *
 * Supports:
 * - Versioning and audit trail
 * - Variable substitution (e.g., {{searchQuery}}, {{userName}})
 * - Usage tracking
 * - Enable/disable toggle
 * - Code defaults with DB overrides (activeVersion=0 means use code default)
 */
export interface IAdminSystemPrompt {
  /** Unique identifier (e.g., 'bike4mind_identity', 'sales_briefing_mode') */
  promptId: string;

  /** Display name for admin UI */
  name: string;

  /** Description of what this prompt does and when it's used */
  description: string;

  /** The actual prompt content (supports variable substitution) */
  content: string;

  /** Category for organization */
  category: string;

  /** Searchable tags */
  tags: string[];

  /** List of supported variable names for substitution (e.g., ['searchQuery', 'userName']) */
  variables: string[];

  /** Enable/disable toggle */
  enabled: boolean;

  /** Latest version number (highest version in history) */
  version: number;

  /** Active version - which version the app uses (0 = code default, 1+ = stored version) */
  activeVersion: number;

  /** Usage statistics */
  usageCount: number;
  successCount: number;
  errorCount: number;
  lastUsedAt: Date | null;

  /** Audit trail */
  createdBy: string;
  lastUpdatedBy: string;
  lastUpdatedByName: string;
}

export interface IAdminSystemPromptDocument extends IAdminSystemPrompt, IMongoDocument {}

/**
 * Categories for admin system prompts
 */
export enum AdminSystemPromptCategory {
  SYSTEM = 'system',
  ADMIN = 'admin',
  AUTOMATION = 'automation',
  VOICE = 'voice',
  OPTIHASHI = 'optihashi',
  SALES_INTELLIGENCE = 'sales_intelligence',
}

/**
 * Variable substitution context
 */
export interface IPromptVariables {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Admin System Prompt History - Stores historical versions of system prompts
 *
 * Each time a prompt is updated, the previous version is saved here.
 * Enables version comparison, rollback, and audit trail.
 */
export interface IAdminSystemPromptHistory {
  /** Links to the parent prompt */
  promptId: string;

  /** Version number at time of snapshot */
  version: number;

  /** Snapshot of prompt content */
  content: string;

  /** Snapshot of metadata at this version */
  name: string;
  description: string;
  category: string;
  tags: string[];
  variables: string[];

  /** Optional reason for this version (e.g., 'Fixed tone', 'Added variable') */
  changeReason?: string;

  /** Who created this version */
  createdBy: string;
  createdByName: string;

  /** When this version was created */
  createdAt: Date;
}

export interface IAdminSystemPromptHistoryDocument extends IAdminSystemPromptHistory, IMongoDocument {}
