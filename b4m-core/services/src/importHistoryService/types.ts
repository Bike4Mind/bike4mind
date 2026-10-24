import { IChatHistoryItem, ISessionRepository, IUser } from '@bike4mind/common';

/**
 * Conversations enumerated and batched, the same unit `onProgress` reports. Not a success
 * count: a conversation failing schema validation is skipped without being counted, so
 * `processedItems` can exceed what actually landed.
 */
export type ImportHistoryResult = {
  processedItems: number;
  totalItems: number;
};

export type ImportHistoryAdapters = {
  db: {
    withTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
    sessions: Pick<ISessionRepository, 'upsertByOpenaiConversationId' | 'upsertByClaudeConversationId'>;
    chatHistoryItems: {
      bulkCreate: (data: (IChatHistoryItem & { id?: string })[]) => Promise<void>;
    };
    users: {
      findById: (id: string) => Promise<IUser | null>;
    };
  };
  onProgress?: (progress: number, currentStep: string, processed: number, total: number) => Promise<void>;
};
