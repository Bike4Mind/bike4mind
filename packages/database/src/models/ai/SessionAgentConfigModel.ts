import mongoose, { Model, Schema } from 'mongoose';
import { ISessionAgentConfig, ISessionAgentConfigDocument, ISessionAgentConfigRepository } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'SessionAgentConfig';

export interface ISessionAgentConfigModel extends Model<ISessionAgentConfigDocument> {}

const SessionAgentConfigSchema = new Schema<ISessionAgentConfig, ISessionAgentConfigModel>(
  {
    sessionId: { type: String, required: true, index: true },
    agentId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    proactiveMessaging: {
      enabled: { type: Boolean, required: true, default: false },
      activeHours: {
        startHour: { type: Number, required: true, min: 0, max: 23 },
        endHour: { type: Number, required: true, min: 0, max: 23 },
        timezone: { type: String, required: false },
      },
      systemPrompt: { type: String, required: false, maxlength: 2000 },
      minIntervalHours: { type: Number, required: false, default: 24, min: 1 },
      lastProactiveMessageAt: { type: Date, required: false },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Compound index for efficient lookups
SessionAgentConfigSchema.index({ sessionId: 1, agentId: 1 }, { unique: true });
SessionAgentConfigSchema.index({ 'proactiveMessaging.enabled': 1 });

const SessionAgentConfigModel =
  (mongoose.models[ModelName] as unknown as ISessionAgentConfigModel) ||
  mongoose.model<ISessionAgentConfig>(ModelName, SessionAgentConfigSchema);

export class SessionAgentConfigRepository
  extends BaseRepository<ISessionAgentConfigDocument>
  implements ISessionAgentConfigRepository
{
  constructor(private sessionAgentConfigModel: ISessionAgentConfigModel) {
    super(sessionAgentConfigModel);
  }

  async findBySessionAndAgent(sessionId: string, agentId: string): Promise<ISessionAgentConfigDocument | null> {
    const result = await this.sessionAgentConfigModel.findOne({
      sessionId,
      agentId,
    });
    return result?.toJSON() ?? null;
  }

  async findBySessionId(sessionId: string): Promise<ISessionAgentConfigDocument[]> {
    const result = await this.sessionAgentConfigModel.find({ sessionId });
    return result.map(doc => doc.toJSON());
  }

  async findAllWithProactiveMessagingEnabled(): Promise<ISessionAgentConfigDocument[]> {
    const result = await this.sessionAgentConfigModel.find({
      'proactiveMessaging.enabled': true,
    });
    return result.map(doc => doc.toJSON());
  }

  async updateLastProactiveMessageAt(
    sessionId: string,
    agentId: string,
    timestamp: Date
  ): Promise<ISessionAgentConfigDocument | null> {
    const result = await this.sessionAgentConfigModel.findOneAndUpdate(
      { sessionId, agentId },
      { 'proactiveMessaging.lastProactiveMessageAt': timestamp },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async deleteBySessionId(sessionId: string): Promise<void> {
    await this.sessionAgentConfigModel.deleteMany({ sessionId });
  }

  async deleteBySessionAndAgent(sessionId: string, agentId: string): Promise<void> {
    await this.sessionAgentConfigModel.deleteOne({ sessionId, agentId });
  }
}

export const sessionAgentConfigRepository = new SessionAgentConfigRepository(SessionAgentConfigModel);

export default SessionAgentConfigRepository;
