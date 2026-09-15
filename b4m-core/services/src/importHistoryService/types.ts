import { IChatHistoryItem, ISessionRepository, IUser } from '@bike4mind/common';

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
