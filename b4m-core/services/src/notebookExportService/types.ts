import type { PromptMeta } from '@bike4mind/common';

// Notebook Export/Import Types
// This defines the standardized format for exporting and importing notebooks/chat sessions

export interface NotebookExportFormat {
  // Export metadata
  exportVersion: string; // Format version for compatibility
  exportedAt: string; // ISO timestamp
  exportedBy?: string; // User ID (optional for privacy)
  platform: string; // source platform identifier

  // Notebooks/Sessions
  notebooks: ExportedNotebook[];
}

export interface ExportedNotebook {
  // Core session data
  id: string; // Original session ID (for reference)
  name: string;
  firstCreated: string; // ISO timestamp
  lastUpdated: string; // ISO timestamp
  language?: string;
  summary?: string;
  summaryAt?: string; // ISO timestamp
  tags: Array<{
    name: string;
    strength: number;
  }>;
  isAutoNamed: boolean;
  lastUsedModel?: string;

  // Chat history
  chatHistory: ExportedChatMessage[];

  // Attachments and resources
  knowledge: ExportedKnowledgeFile[];
  artifacts: ExportedArtifact[];
  tools: ExportedTool[];
  agents: ExportedAgent[];

  // Metadata for import handling
  clonedFromId?: string; // If this was cloned
  forkedFromId?: string; // If this was forked
}

export interface ExportedChatMessage {
  /**
   * Required: re-import keys `updateOne` on this. A missing id casts the filter to `{}`, which
   * upserts over an arbitrary document, so a row without one is not exportable.
   */
  id: string;
  timestamp: string; // ISO timestamp
  /**
   * Mirrors IChatHistoryItemDocument['type']. `voice_transcript` was missing here: stored rows
   * carry it, so exports already contained a value this contract did not admit.
   */
  type: 'message' | 'oob' | 'error' | 'system' | 'voice_transcript';

  // User input
  prompt: string;

  // AI responses
  reply?: string; // Single reply
  replies?: string[]; // Multiple replies/variations
  questMasterReply?: string; // Formatted reply

  // Attachments
  images?: string[]; // Base64 encoded images or references
  attachedFiles?: string[]; // References to knowledge files

  // Metadata
  /**
   * Derived from PromptMeta so it cannot drift from what the mapper passes through. Consumers
   * already read this nested shape - see the bulk-export spreadsheet builder.
   */
  promptMeta?: {
    /** Passed through whole, so derived - narrowing here would silently drop emitted fields. */
    model?: PromptMeta['model'];
    tokenUsage?: PromptMeta['tokenUsage'];
    /** Projected by the mapper: the full groups carry raw prompt text this export must not ship. */
    performance?: { totalResponseTime?: number };
    context?: { contextWindowUsage?: NonNullable<PromptMeta['context']>['contextWindowUsage'] };
  };

  // Status and interaction
  status: 'stopped' | 'running' | 'done';
  creditsUsed?: number;
  pinned: boolean;

  // Agent involvement
  agentIds?: string[];
  questMasterPlanId?: string;
}

export interface ExportedKnowledgeFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string; // ISO timestamp
  content?: string; // Base64 encoded content for small files
  contentUrl?: string; // Reference URL for large files
  metadata?: Record<string, unknown>;
}

export interface ExportedArtifact {
  id: string;
  name: string;
  type: string;
  /** Optional: the artifact body lives in a separate collection and is not joined by this export. */
  content?: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  metadata?: Record<string, unknown>;
}

export interface ExportedTool {
  id: string;
  name: string;
  description?: string;
  /** Optional: the tool entity has no `configuration` field; `llmParams` is the nearest thing
   * and is deliberately not exported. */
  configuration?: Record<string, unknown>;
  createdAt: string; // ISO timestamp
  metadata?: Record<string, unknown>;
}

export interface ExportedAgent {
  id: string;
  name: string;
  description?: string;
  /** Optional: the agent entity has no `configuration` field to source this from. */
  configuration?: Record<string, unknown>;
  createdAt: string; // ISO timestamp
  metadata?: Record<string, unknown>;
}

// Import configuration options
export interface NotebookImportOptions {
  // How to handle conflicts
  conflictResolution: 'skip' | 'overwrite' | 'rename' | 'merge';

  // Whether to preserve IDs (for same-platform imports)
  preserveIds: boolean;

  // Whether to import attachments
  importKnowledge: boolean;
  importArtifacts: boolean;
  importTools: boolean;
  importAgents: boolean;

  // Target user (for admin imports)
  targetUserId?: string;

  // Prefix for imported notebook names
  namePrefix?: string;
}

// Export configuration options
export interface NotebookExportOptions {
  // Which notebooks to export (empty = all)
  notebookIds?: string[];

  // Whether to include attachments
  includeKnowledge: boolean;
  includeArtifacts: boolean;
  includeTools: boolean;
  includeAgents: boolean;

  // Privacy options
  anonymize: boolean; // Remove user-identifying information
  includeMetadata: boolean; // Include cost, token usage, etc.

  // Content options
  includeImages: boolean; // Embed images as base64
  maxFileSize: number; // Max size for embedded files (bytes)

  // Date range filtering
  fromDate?: string; // ISO timestamp
  toDate?: string; // ISO timestamp
}

// Processing result types
export interface ExportResult {
  success: boolean;
  fileName: string;
  fileSize: number;
  notebookCount: number;
  messageCount: number;
  attachmentCount: number;
  errors?: string[];
  downloadUrl?: string;
}

export interface ImportResult {
  success: boolean;
  importedNotebooks: number;
  importedMessages: number;
  importedAttachments: number;
  skippedNotebooks: number;
  errors?: string[];
  warnings?: string[];
  newNotebookIds?: string[];
}

// Validation schemas
export interface FormatVersion {
  major: number;
  minor: number;
  patch: number;
}

export const CURRENT_EXPORT_VERSION = '1.0.0';
export const SUPPORTED_IMPORT_VERSIONS = ['1.0.0'];

// Error types
export class NotebookExportError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'NotebookExportError';
  }
}

export class NotebookImportError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'NotebookImportError';
  }
}

type Expect<T extends true> = T;

/**
 * Compile-time guard: these interfaces are re-exported from the package entry point, so re-loosening
 * one to `any` becomes a consumer's looseness. One row per type, so a failure names the regression.
 * Lives in src, not a test: tsconfig excludes *.test.ts, so only `turbo:typecheck` enforces it.
 * Same kind of guard, same placement reason, as common's modelCatalog.ts.
 */
export type NotebookExportTypesStayNarrowed = [
  Expect<0 extends 1 & NonNullable<ExportedKnowledgeFile['metadata']>[string] ? false : true>,
  Expect<0 extends 1 & NonNullable<ExportedArtifact['metadata']>[string] ? false : true>,
  Expect<0 extends 1 & NonNullable<ExportedTool['metadata']>[string] ? false : true>,
  Expect<0 extends 1 & NonNullable<ExportedAgent['metadata']>[string] ? false : true>,
  Expect<0 extends 1 & NonNullable<ExportedTool['configuration']>[string] ? false : true>,
  Expect<0 extends 1 & NonNullable<ExportedAgent['configuration']>[string] ? false : true>,
  Expect<0 extends 1 & NotebookExportError['details'] ? false : true>,
  Expect<0 extends 1 & NotebookImportError['details'] ? false : true>,
];
