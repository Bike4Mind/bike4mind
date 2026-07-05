import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'StockPortfolio';

/** Starting cash balance for new agent portfolios. Keep in sync with STARTING_CASH_BALANCE in stockTypes.ts (client). */
export const STARTING_CASH_BALANCE = 10_000;

// Interfaces

export interface IStockHolding {
  symbol: string;
  shares: number;
  /** Weighted-average price paid per share */
  avgCostBasis: number;
}

export interface IStockPortfolioDoc {
  _id: string;
  agentId: string;
  agentName: string;
  userId: string;
  cashBalance: number;
  holdings: IStockHolding[];
  /** Running total of cash spent on buys (lifetime) */
  totalInvested: number;
  createdAt: Date;
  updatedAt: Date;
}

// Schema

interface IStockPortfolioModel extends Model<IStockPortfolioDoc> {}

const HoldingSchema = new Schema<IStockHolding>(
  {
    symbol: { type: String, required: true },
    shares: { type: Number, required: true },
    avgCostBasis: { type: Number, required: true },
  },
  { _id: false }
);

const StockPortfolioSchema = new Schema<IStockPortfolioDoc>(
  {
    agentId: { type: String, required: true, unique: true },
    agentName: { type: String, required: true },
    userId: { type: String, required: true },
    cashBalance: { type: Number, default: STARTING_CASH_BALANCE },
    holdings: { type: [HoldingSchema], default: [] },
    totalInvested: { type: Number, default: 0 },
  },
  { timestamps: true }
);

StockPortfolioSchema.index({ userId: 1, agentId: 1 });

export const StockPortfolio: IStockPortfolioModel =
  (mongoose.models[ModelName] as IStockPortfolioModel) ||
  model<IStockPortfolioDoc, IStockPortfolioModel>(ModelName, StockPortfolioSchema);

// Repository

export const stockPortfolioRepository = {
  /** Get or create a portfolio for an agent. Uses upsert for race-safety. */
  async getOrCreatePortfolio(agentId: string, agentName: string, userId: string): Promise<IStockPortfolioDoc> {
    const doc = await StockPortfolio.findOneAndUpdate(
      { agentId },
      {
        $setOnInsert: {
          agentId,
          agentName,
          userId,
          cashBalance: STARTING_CASH_BALANCE,
          holdings: [],
          totalInvested: 0,
        },
      },
      { upsert: true, new: true }
    ).lean();
    return doc;
  },

  /** Get a single portfolio by agentId. */
  async getPortfolio(agentId: string): Promise<IStockPortfolioDoc | null> {
    return StockPortfolio.findOne({ agentId }).lean();
  },

  /** Get all portfolios for a user's tavern (for leaderboard). */
  async getPortfoliosByUser(userId: string): Promise<IStockPortfolioDoc[]> {
    return StockPortfolio.find({ userId }).lean();
  },

  /**
   * Execute a stock purchase atomically.
   *
   * Uses an aggregation pipeline update (MongoDB 4.2+) so the weighted-
   * average cost basis is computed from the document's own fields inside
   * a single atomic findOneAndUpdate - no read-then-write race.
   *
   * Phase 1: Try to update an existing holding (atomic pipeline).
   * Phase 2: Push a new holding with a $ne guard to prevent duplicates.
   * Phase 3: Retry phase 1 if a concurrent buy created the holding
   *          between phases 1 and 2.
   *
   * Returns the updated portfolio, or null if insufficient funds.
   */
  async executeBuy(
    agentId: string,
    symbol: string,
    shares: number,
    pricePerShare: number
  ): Promise<IStockPortfolioDoc | null> {
    const totalCost = shares * pricePerShare;
    const upperSymbol = symbol.toUpperCase();

    // Aggregation pipeline: atomically compute new weighted avg cost basis
    const updateExistingPipeline = [
      {
        $set: {
          cashBalance: { $subtract: ['$cashBalance', totalCost] },
          totalInvested: { $add: ['$totalInvested', totalCost] },
          holdings: {
            $map: {
              input: '$holdings',
              as: 'h',
              in: {
                $cond: {
                  if: { $eq: ['$$h.symbol', upperSymbol] },
                  then: {
                    symbol: '$$h.symbol',
                    shares: { $add: ['$$h.shares', shares] },
                    avgCostBasis: {
                      $divide: [
                        { $add: [{ $multiply: ['$$h.shares', '$$h.avgCostBasis'] }, totalCost] },
                        { $add: ['$$h.shares', shares] },
                      ],
                    },
                  },
                  else: '$$h',
                },
              },
            },
          },
        },
      },
    ];

    // Phase 1: update existing holding atomically
    const existingResult = await StockPortfolio.findOneAndUpdate(
      { agentId, cashBalance: { $gte: totalCost }, 'holdings.symbol': upperSymbol },
      updateExistingPipeline,
      { new: true }
    ).lean();
    if (existingResult) return existingResult;

    // Phase 2: no existing holding - push a new one.
    // The $ne guard prevents duplicate entries if a concurrent buy creates the holding.
    const newResult = await StockPortfolio.findOneAndUpdate(
      { agentId, cashBalance: { $gte: totalCost }, 'holdings.symbol': { $ne: upperSymbol } },
      {
        $inc: { cashBalance: -totalCost, totalInvested: totalCost },
        $push: { holdings: { symbol: upperSymbol, shares, avgCostBasis: pricePerShare } },
      },
      { new: true }
    ).lean();
    if (newResult) return newResult;

    // Phase 3: concurrent buy created the holding between phases 1 and 2 - retry.
    return StockPortfolio.findOneAndUpdate(
      { agentId, cashBalance: { $gte: totalCost }, 'holdings.symbol': upperSymbol },
      updateExistingPipeline,
      { new: true }
    ).lean();
  },

  /**
   * Execute a stock sale atomically.
   *
   * Decrements shares, increments cash. Removes the holding entry
   * when shares reach zero.
   *
   * Returns updated portfolio, or null if insufficient shares.
   */
  async executeSell(
    agentId: string,
    symbol: string,
    shares: number,
    pricePerShare: number
  ): Promise<IStockPortfolioDoc | null> {
    const totalProceeds = shares * pricePerShare;
    const upperSymbol = symbol.toUpperCase();

    const portfolio = await StockPortfolio.findOne({ agentId }).lean();
    if (!portfolio) return null;

    const holding = portfolio.holdings.find(h => h.symbol === upperSymbol);
    if (!holding || holding.shares < shares) return null;

    if (holding.shares === shares) {
      // Sell all -- remove the holding
      const result = await StockPortfolio.findOneAndUpdate(
        { agentId, 'holdings.symbol': upperSymbol, 'holdings.shares': { $gte: shares } },
        {
          $inc: { cashBalance: totalProceeds },
          $pull: { holdings: { symbol: upperSymbol } },
        },
        { new: true }
      ).lean();
      return result;
    } else {
      // Partial sell -- decrement shares, keep avg cost basis
      const result = await StockPortfolio.findOneAndUpdate(
        { agentId, 'holdings.symbol': upperSymbol, 'holdings.shares': { $gte: shares } },
        {
          $inc: { cashBalance: totalProceeds, 'holdings.$.shares': -shares },
        },
        { new: true }
      ).lean();
      return result;
    }
  },
};
