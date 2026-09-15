import { CurationArtifactType } from '../../schemas/curation';

/** An artifact extracted from a conversation message. */
export interface ExtractedArtifact {
  type: CurationArtifactType;
  content: string;
  language?: string; // For code blocks (e.g., 'typescript', 'python')
  messageId: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Curation Progress Stage
 */
export type CurationStage = 'loading' | 'extracting' | 'generating' | 'storing';

/** Progress callback payload for real-time updates. */
export interface CurationProgress {
  stage: CurationStage;
  percentage: number;
  message?: string;
  messagesProcessed?: number;
  totalMessages?: number;
  artifactsFound?: number;
}

/** Result returned from the curation service. */
export interface CurationResult {
  success: boolean;
  curatedFileId?: string;
  fileName?: string;
  fileSize?: number;
  artifactCount?: number;
  messageCount?: number;
  tokensProcessed?: number;
  tokensDeducted?: number;
  error?: string;
}

/** Error thrown on curation failure. */
export class NotebookCurationError extends Error {
  constructor(
    message: string,
    public code: 'SESSION_NOT_FOUND' | 'INSUFFICIENT_TOKENS' | 'EXPORT_FAILED' | 'STORAGE_FAILED',
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'NotebookCurationError';
  }
}
