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
  /**
   * False only for a failure that cannot succeed on redelivery (e.g. an admission gate
   * refusal). Absent/true means the caller should retry as before - a queue handler
   * rethrows to let SQS redeliver, only skipping that for an explicit `false`.
   */
  retryable?: boolean;
}

/** Error thrown on curation failure. */
export class NotebookCurationError extends Error {
  constructor(
    message: string,
    public code: 'SESSION_NOT_FOUND' | 'INSUFFICIENT_TOKENS' | 'EXPORT_FAILED' | 'STORAGE_FAILED' | 'ADMISSION_REFUSED',
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'NotebookCurationError';
  }
}
