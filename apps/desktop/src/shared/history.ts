export type LocalHistoryKind = 'session' | 'page';

export interface LocalHistoryResult {
  id: string;
  kind: LocalHistoryKind;
  sessionId: string;
  title: string;
  url?: string;
  snippet: string;
  capturedAt: string;
}

export interface LocalHistoryState {
  entries: number;
}
