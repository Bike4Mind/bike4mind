import { IMongoDocument } from './common';

export interface IVoice extends IMongoDocument {
  userId: string;
  voiceId: string;
  type: string;
  description?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
