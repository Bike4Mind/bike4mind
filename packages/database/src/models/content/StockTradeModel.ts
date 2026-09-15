import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StockTrade';

// Interface

export interface IStockTradeDoc {
  _id: string;
  agentId: string;
  agentName: string;
  userId: string;
  symbol: string;
  side: 'buy' | 'sell';
  shares: number;
  pricePerShare: number;
  /** shares * pricePerShare */
  totalValue: number;
  /** Agent's cash balance immediately after the trade */
  cashBalanceAfter: number;
  createdAt: Date;
}

// Schema

interface IStockTradeModel extends Model<IStockTradeDoc> {}

const StockTradeSchema = new Schema<IStockTradeDoc>(
  {
    agentId: { type: String, required: true },
    agentName: { type: String, required: true },
    userId: { type: String, required: true },
    symbol: { type: String, required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    shares: { type: Number, required: true },
    pricePerShare: { type: Number, required: true },
    totalValue: { type: Number, required: true },
    cashBalanceAfter: { type: Number, required: true },
  },
  { timestamps: true }
);

StockTradeSchema.index({ userId: 1, createdAt: -1 });
StockTradeSchema.index({ agentId: 1, createdAt: -1 });

export const StockTrade: IStockTradeModel =
  (mongoose.models[ModelName] as IStockTradeModel) ||
  model<IStockTradeDoc, IStockTradeModel>(ModelName, StockTradeSchema);

// Repository

export const stockTradeRepository = {
  /** Record a trade. */
  async recordTrade(trade: Omit<IStockTradeDoc, '_id' | 'createdAt'>): Promise<IStockTradeDoc> {
    const doc = await StockTrade.create(trade);
    return doc.toObject();
  },

  /** Recent trades across all agents in a user's tavern. */
  async getTradesForUser(userId: string, limit = 50): Promise<IStockTradeDoc[]> {
    return StockTrade.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  },

  /** Recent trades for a single agent (scoped to userId to prevent cross-tenant leaks). */
  async getTradesForAgent(agentId: string, userId: string, limit = 50): Promise<IStockTradeDoc[]> {
    return StockTrade.find({ agentId, userId }).sort({ createdAt: -1 }).limit(limit).lean();
  },
};
