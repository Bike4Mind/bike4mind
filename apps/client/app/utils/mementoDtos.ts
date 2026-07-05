export interface CreateMementoDTO {
  userId?: string; // injected server-side if omitted
  sessionId: string | null; // required - must be provided
  questId?: string;
  type: 'prompt' | 'reply' | 'insight' | 'context';
  tier: 'hot' | 'warm' | 'cold';
  weight: number;
  summary: string;
  fullContent: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  lastAccessedAt?: Date; // server defaults to now if absent
  isArchived?: boolean;
}

// Only fields that can be changed after creation.
export interface UpdateMementoDTO {
  weight?: number;
  summary?: string;
  tier?: 'hot' | 'warm' | 'cold';
  tags?: string[];
  lastAccessedAt?: Date;
  metadata?: Record<string, unknown>;
}
