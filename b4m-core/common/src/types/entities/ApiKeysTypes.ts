import { IBaseRepository, IMongoDocument } from '.';

export enum ApiKeyType {
  openai = 'openAi',
  elevenlabs = 'elevenLabs',
  anthropic = 'anthropic',
  serpapi = 'serpapi',
  gemini = 'gemini',
  bfl = 'bfl',
  ollama = 'ollama',
  xai = 'xai',
  voyageai = 'voyageai',
}

export interface IApiKey {
  userId: string;
  apiKey: string;
  type: ApiKeyType;
  description?: string;
  isActive: boolean;
  expiresAt: Date;
}

export interface IApiKeyDocument extends IApiKey, IMongoDocument {}

export interface IApiKeyRepository extends IBaseRepository<IApiKeyDocument> {
  findByUserIdAndType: (userId: string, type: ApiKeyType) => Promise<IApiKeyDocument | null>;
  findByUserIdAndTypes: (userId: string, types: ApiKeyType[]) => Promise<IApiKeyDocument[]>;
  findByIdAndUserId: (id: string, userId: string) => Promise<IApiKeyDocument | null>;
  findByIdAndUserIdAndType: (id: string, userId: string, type: ApiKeyType) => Promise<IApiKeyDocument | null>;
  findAllByUserId: (userId: string) => Promise<IApiKeyDocument[]>;
  updateAllByUserId: (userId: string, value: Partial<IApiKeyDocument>) => Promise<unknown>;
  updateAllByUserIdAndType: (userId: string, type: ApiKeyType, value: Partial<IApiKeyDocument>) => Promise<unknown>;
}
