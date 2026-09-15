import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

export interface IEmbeddingCacheDocument extends IMongoDocument {
  contentHash: string;
  vector: number[];
  model: string;
  tokenCount: number;
  createdAt: Date;
  accessCount: number;
  lastAccessedAt: Date;
}

export interface IEmbeddingCacheRepository extends IBaseRepository<IEmbeddingCacheDocument> {
  findByHash(contentHash: string, model: string): Promise<IEmbeddingCacheDocument | null>;
  upsert(
    data: Omit<IEmbeddingCacheDocument, 'id' | 'accessCount' | 'lastAccessedAt'>
  ): Promise<IEmbeddingCacheDocument>;
  incrementAccessCount(contentHash: string, model: string): Promise<void>;
}
