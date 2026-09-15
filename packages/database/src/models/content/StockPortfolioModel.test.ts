import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { stockPortfolioRepository, StockPortfolio, STARTING_CASH_BALANCE } from './StockPortfolioModel';
import { setupMongoTest } from '../../__test__/utils';

describe('StockPortfolioRepository', () => {
  setupMongoTest();

  function newAgentId() {
    return new mongoose.Types.ObjectId().toString();
  }

  async function seed(opts?: { cashBalance?: number }) {
    const agentId = newAgentId();
    const userId = new mongoose.Types.ObjectId().toString();
    await stockPortfolioRepository.getOrCreatePortfolio(agentId, 'Test Agent', userId);
    if (opts?.cashBalance !== undefined) {
      await StockPortfolio.updateOne({ agentId }, { $set: { cashBalance: opts.cashBalance } });
    }
    return { agentId, userId };
  }

  describe('executeBuy — weighted-average cost basis', () => {
    it('buy 10 @ 100 then 5 @ 110 → avgCost ≈ 103.33', async () => {
      const { agentId } = await seed();

      await stockPortfolioRepository.executeBuy(agentId, 'AAPL', 10, 100);
      const after = await stockPortfolioRepository.executeBuy(agentId, 'AAPL', 5, 110);

      expect(after).not.toBeNull();
      const holding = after!.holdings.find(h => h.symbol === 'AAPL');
      expect(holding).toBeDefined();
      expect(holding!.shares).toBe(15);
      // (10*100 + 5*110) / 15 = 1550 / 15 = 103.333...
      expect(holding!.avgCostBasis).toBeCloseTo(103.333, 2);
      // Cash: 10000 - 1000 - 550 = 8450
      expect(after!.cashBalance).toBeCloseTo(8450, 5);
      expect(after!.totalInvested).toBeCloseTo(1550, 5);
    });

    it('uppercases the symbol on insert', async () => {
      const { agentId } = await seed();

      const result = await stockPortfolioRepository.executeBuy(agentId, 'aapl', 1, 50);

      expect(result!.holdings[0].symbol).toBe('AAPL');
    });
  });

  describe('executeBuy — concurrency', () => {
    it('two concurrent buys on a new symbol create exactly one holding row', async () => {
      const { agentId } = await seed();

      const [a, b] = await Promise.all([
        stockPortfolioRepository.executeBuy(agentId, 'MSFT', 3, 100),
        stockPortfolioRepository.executeBuy(agentId, 'MSFT', 2, 100),
      ]);

      // Both should succeed (plenty of cash)
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();

      const finalDoc = await stockPortfolioRepository.getPortfolio(agentId);
      const msftHoldings = finalDoc!.holdings.filter(h => h.symbol === 'MSFT');
      expect(msftHoldings).toHaveLength(1);
      expect(msftHoldings[0].shares).toBe(5);
    });

    it('concurrent buys against insufficient cash → one succeeds, cash never negative', async () => {
      // Only enough cash for exactly one 100-share buy @ $100 = $10,000
      const { agentId } = await seed({ cashBalance: 10_000 });

      const [a, b] = await Promise.all([
        stockPortfolioRepository.executeBuy(agentId, 'GOOG', 100, 100),
        stockPortfolioRepository.executeBuy(agentId, 'GOOG', 100, 100),
      ]);

      const successes = [a, b].filter(r => r !== null);
      expect(successes).toHaveLength(1);

      const finalDoc = await stockPortfolioRepository.getPortfolio(agentId);
      expect(finalDoc!.cashBalance).toBeGreaterThanOrEqual(0);
      expect(finalDoc!.cashBalance).toBeCloseTo(0, 5);
      const googHolding = finalDoc!.holdings.find(h => h.symbol === 'GOOG');
      expect(googHolding!.shares).toBe(100);
    });

    it('returns null when cash is insufficient', async () => {
      const { agentId } = await seed({ cashBalance: 50 });

      const result = await stockPortfolioRepository.executeBuy(agentId, 'NVDA', 1, 100);

      expect(result).toBeNull();
      const doc = await stockPortfolioRepository.getPortfolio(agentId);
      expect(doc!.cashBalance).toBe(50);
      expect(doc!.holdings).toHaveLength(0);
    });
  });

  describe('executeSell', () => {
    it('partial sell preserves avgCostBasis', async () => {
      const { agentId } = await seed();
      await stockPortfolioRepository.executeBuy(agentId, 'TSLA', 10, 200);

      const result = await stockPortfolioRepository.executeSell(agentId, 'TSLA', 3, 250);

      expect(result).not.toBeNull();
      const holding = result!.holdings.find(h => h.symbol === 'TSLA');
      expect(holding).toBeDefined();
      expect(holding!.shares).toBe(7);
      expect(holding!.avgCostBasis).toBe(200); // unchanged
      // Cash: 10000 - 2000 + 750 = 8750
      expect(result!.cashBalance).toBeCloseTo(8750, 5);
    });

    it('full sell removes the holding entry', async () => {
      const { agentId } = await seed();
      await stockPortfolioRepository.executeBuy(agentId, 'AMZN', 4, 150);

      const result = await stockPortfolioRepository.executeSell(agentId, 'AMZN', 4, 175);

      expect(result).not.toBeNull();
      expect(result!.holdings.find(h => h.symbol === 'AMZN')).toBeUndefined();
      // Cash: 10000 - 600 + 700 = 10100
      expect(result!.cashBalance).toBeCloseTo(10100, 5);
    });

    it('rejects oversell (returns null, does not touch portfolio)', async () => {
      const { agentId } = await seed();
      await stockPortfolioRepository.executeBuy(agentId, 'META', 2, 300);

      const result = await stockPortfolioRepository.executeSell(agentId, 'META', 10, 350);

      expect(result).toBeNull();
      const doc = await stockPortfolioRepository.getPortfolio(agentId);
      const holding = doc!.holdings.find(h => h.symbol === 'META');
      expect(holding!.shares).toBe(2);
    });

    it('concurrent oversell — only one sell can succeed', async () => {
      const { agentId } = await seed();
      // Hold 5 shares; two racers each try to sell 5.
      await stockPortfolioRepository.executeBuy(agentId, 'AAPL', 5, 100);

      const [a, b] = await Promise.all([
        stockPortfolioRepository.executeSell(agentId, 'AAPL', 5, 120),
        stockPortfolioRepository.executeSell(agentId, 'AAPL', 5, 120),
      ]);

      const successes = [a, b].filter(r => r !== null);
      expect(successes).toHaveLength(1);

      const finalDoc = await stockPortfolioRepository.getPortfolio(agentId);
      expect(finalDoc!.holdings.find(h => h.symbol === 'AAPL')).toBeUndefined();
    });
  });

  describe('getOrCreatePortfolio', () => {
    it('creates a portfolio with the starting cash balance', async () => {
      const agentId = newAgentId();
      const userId = new mongoose.Types.ObjectId().toString();

      const result = await stockPortfolioRepository.getOrCreatePortfolio(agentId, 'New Agent', userId);

      expect(result.cashBalance).toBe(STARTING_CASH_BALANCE);
      expect(result.holdings).toHaveLength(0);
      expect(result.totalInvested).toBe(0);
    });

    it('is idempotent for the same agentId', async () => {
      const agentId = newAgentId();
      const userId = new mongoose.Types.ObjectId().toString();

      await stockPortfolioRepository.getOrCreatePortfolio(agentId, 'Agent', userId);
      await stockPortfolioRepository.executeBuy(agentId, 'SPY', 1, 400);
      const second = await stockPortfolioRepository.getOrCreatePortfolio(agentId, 'Agent', userId);

      // Second call should not reset cash/holdings
      expect(second.cashBalance).toBeCloseTo(STARTING_CASH_BALANCE - 400, 5);
      expect(second.holdings).toHaveLength(1);
    });
  });
});
