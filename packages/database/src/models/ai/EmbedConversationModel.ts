import mongoose, { Model, Schema } from 'mongoose';

const ModelName = 'EmbedConversation';

/**
 * Conversation history for an identified embed user, one row per (user, agent).
 * Anonymous embed sessions never write here (they are stateless by design); only a
 * session minted against the host's authenticated user does, so the history belongs
 * to that user and bills nobody else. See server/chatCompletion/external/embedRoute.ts.
 */
export interface IEmbedConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export interface IEmbedConversation {
  userId: string;
  agentId: string;
  /** Embed key that last wrote this row; attribution only, not part of the identity. */
  keyId: string;
  messages: IEmbedConversationMessage[];
  createdAt: Date;
  updatedAt: Date;
}

/** Rows untouched this long are dropped by the TTL index (retention bound). */
export const EMBED_CONVERSATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Oldest turns are sliced off past this, so a long-lived row cannot grow without bound. */
export const EMBED_CONVERSATION_MAX_MESSAGES = 200;

export interface IEmbedConversationModel extends Model<IEmbedConversation> {}

const EmbedConversationMessageSchema = new Schema<IEmbedConversationMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false }
);

const EmbedConversationSchema = new Schema<IEmbedConversation, IEmbedConversationModel>(
  {
    userId: { type: String, required: true },
    agentId: { type: String, required: true },
    keyId: { type: String, required: true },
    messages: { type: [EmbedConversationMessageSchema], default: [] },
  },
  { timestamps: true }
);

EmbedConversationSchema.index({ userId: 1, agentId: 1 }, { unique: true });
EmbedConversationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: EMBED_CONVERSATION_RETENTION_SECONDS });

const EmbedConversationModel =
  (mongoose.models[ModelName] as unknown as IEmbedConversationModel) ||
  mongoose.model<IEmbedConversation, IEmbedConversationModel>(ModelName, EmbedConversationSchema);

export class EmbedConversationRepository {
  constructor(private model: IEmbedConversationModel) {}

  /** Oldest-first; `limit` keeps only the newest N, sliced in the query rather than in memory. */
  async getMessages(userId: string, agentId: string, limit?: number): Promise<IEmbedConversationMessage[]> {
    const projection = limit ? { messages: { $slice: -limit } } : { messages: 1 };
    const row = await this.model.findOne({ userId, agentId }, projection).lean();
    return row?.messages ?? [];
  }

  async appendMessages(
    userId: string,
    agentId: string,
    keyId: string,
    messages: Array<Pick<IEmbedConversationMessage, 'role' | 'content'>>
  ): Promise<void> {
    const now = new Date();
    await this.model.updateOne(
      { userId, agentId },
      {
        $set: { keyId },
        $push: {
          messages: {
            $each: messages.map(m => ({ role: m.role, content: m.content, createdAt: now })),
            $slice: -EMBED_CONVERSATION_MAX_MESSAGES,
          },
        },
      },
      { upsert: true }
    );
  }

  async deleteConversation(userId: string, agentId: string): Promise<void> {
    await this.model.deleteOne({ userId, agentId });
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.model.deleteMany({ userId });
    return result.deletedCount ?? 0;
  }
}

export const embedConversationRepository = new EmbedConversationRepository(EmbedConversationModel);

export default EmbedConversationModel;
