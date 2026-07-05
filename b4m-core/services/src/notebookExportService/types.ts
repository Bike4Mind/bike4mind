// Notebook Export/Import Types
// This defines the standardized format for exporting and importing notebooks/chat sessions

export interface NotebookExportFormat {
  // Export metadata
  exportVersion: string; // Format version for compatibility
  exportedAt: string; // ISO timestamp
  exportedBy?: string; // User ID (optional for privacy)
  platform: string; // "lumina5" or source platform

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
  id: string; // Original quest/message ID
  timestamp: string; // ISO timestamp
  type: 'message' | 'oob' | 'error' | 'system';

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
  promptMeta?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    tokensUsed?: number;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    responseTime?: number;
    contextLength?: number;
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
  metadata?: Record<string, any>;
}

export interface ExportedArtifact {
  id: string;
  name: string;
  type: string;
  content: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  metadata?: Record<string, any>;
}

export interface ExportedTool {
  id: string;
  name: string;
  description?: string;
  configuration: Record<string, any>;
  createdAt: string; // ISO timestamp
  metadata?: Record<string, any>;
}

export interface ExportedAgent {
  id: string;
  name: string;
  description?: string;
  configuration: Record<string, any>;
  createdAt: string; // ISO timestamp
  metadata?: Record<string, any>;
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
    public details?: any
  ) {
    super(message);
    this.name = 'NotebookExportError';
  }
}

export class NotebookImportError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'NotebookImportError';
  }
}
