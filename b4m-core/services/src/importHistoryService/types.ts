import { IChatHistoryItem, ISessionRepository, IUser } from '@bike4mind/common';

/** What the import actually processed, in conversations - the same unit `onProgress` reports. */
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
