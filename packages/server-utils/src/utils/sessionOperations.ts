import { ISessionDocument, isTagAttemptDue } from '@bike4mind/common';

export type SpiderOperation = 'messageCount' | 'curation' | 'summarize' | 'tags' | 'embeddings';

export interface SessionGroomingResult {
  sessionId: string;
  sessionName: string;
  operations: {
    messageCount: boolean;
    curation: boolean;
    summarize: boolean;
    tags: boolean;
    embeddings: boolean;
  };
  messagesEmbedded?: number;
  skipped: boolean;
  error?: string;
}

/**
 * Pure function, no side effects.
 * Embeddings always run when requested (checked per-message, not per-session).
 */
export function determineSessionOperations(
  session: ISessionDocument,
  requestedOperations: SpiderOperation[]
): SessionGroomingResult['operations'] {
  return {
    messageCount: requestedOperations.includes('messageCount'),
    curation: requestedOperations.includes('curation') && !session.curatedAt,
    summarize: requestedOperations.includes('summarize') && !session.summaryAt,
    // `isTagAttemptDue` holds back a notebook whose last completion produced no usable tags until
    // its backoff expires. Keep it in step with `sessionRepository.countTaggableNotebooks`, which
    // prices what this dispatches.
    tags: requestedOperations.includes('tags') && !session.taggedAt && isTagAttemptDue(session),
    embeddings: requestedOperations.includes('embeddings'), // Always run when requested (per-message check)
  };
}

export function hasOperationsToPerform(operations: SessionGroomingResult['operations']): boolean {
  return Object.values(operations).some(Boolean);
}
