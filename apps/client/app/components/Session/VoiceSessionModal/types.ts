export interface TranscriptItem {
  itemId: string;
  role?: 'user' | 'assistant';
  title?: string;
  data?: Record<string, unknown>;
  timestamp: Date;
  createdAtMs: number;
  status: 'IN_PROGRESS' | 'DONE';
  isHidden: boolean;
}
