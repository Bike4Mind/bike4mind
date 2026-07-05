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
}
