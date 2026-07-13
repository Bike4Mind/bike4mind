import { IBaseRepository, IMongoDocument } from './index';

export enum MementoTier {
  HOT = 'hot',
  WARM = 'warm',
  COLD = 'cold',
}

export enum MementoType {
  PROMPT = 'prompt',
  REPLY = 'reply',
  INSIGHT = 'insight',
  CONTEXT = 'context',
}

export interface IMemento {
  userId: string;
  /**
   * This can be null, especially when it is created manually or via import.
   */
  sessionId: string | null;
  questId?: string;
  type: MementoType;
  tier: MementoTier;
  weight: number;
  summary: string;
  fullContent: string;
  embedding?: number[];
  /** The embedding model that produced `embedding`. Absent on mementos written before it was recorded. */
  embeddingModel?: string;
  metadata?: Record<string, unknown>;
  lastAccessedAt: Date;
  isArchived: boolean;
  tags?: string[];
}

export interface IMementoDocument extends IMemento, IMongoDocument {
  decayWeight(): Promise<void>; // Apply decay logic to weight
  updateWeight(delta: number): Promise<void>; // Adjust weight dynamically
  promote(): Promise<void>; // Move to 'hot' or higher speed
  demote(): Promise<void>; // Move to 'cold' or lower speed
}

export interface IMementoRepository extends IBaseRepository<IMementoDocument> {
  findByUserId(
    userId: string,
    options: {
      tier?: MementoTier;
      select?: string;
    }
  ): Promise<IMementoDocument[]>;
  /**
   * Hard-delete every memento belonging to a user. This is the "delete my data" path: a memento
   * holds the summary, the full original prompt and a plaintext embedding, none of which is
   * encrypted, so it cannot be crypto-shredded like a ledger fact - it has to actually go.
   * Returns the number deleted.
   */
  deleteAllByUserId(userId: string): Promise<number>;
}
