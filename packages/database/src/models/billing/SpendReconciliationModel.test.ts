import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SpendReconciliation, spendReconciliationRepository } from './SpendReconciliationModel';
import { ISpendReconciliationInput } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await SpendReconciliation.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await SpendReconciliation.deleteMany({});
});

const baseRow: ISpendReconciliationInput = {
  month: '2026-07',
  provider: 'anthropic',
  providerUsd: 500,
  internalUsd: 485,
  deltaUsd: 15,
  deltaPct: 3,
  source: 'anthropic_admin_api',
};

const append = (overrides: Partial<ISpendReconciliationInput> = {}) =>
  spendReconciliationRepository.append({ ...baseRow, ...overrides });

describe('SpendReconciliationRepository', () => {
  describe('append', () => {
    it('persists a row with timestamps', async () => {
      const doc = await append();
      expect(doc.providerUsd).toBe(500);
      expect(doc.deltaUsd).toBe(15);
      expect(doc.createdAt).toBeInstanceOf(Date);
    });

    it('rejects a malformed month', async () => {
      await expect(append({ month: '2026-7' })).rejects.toThrow();
    });

    it('stores optional breakdown', async () => {
      const doc = await append({ providerBreakdown: { 'key-1': 300, 'key-2': 200 } });
      expect(doc.providerBreakdown).toEqual({ 'key-1': 300, 'key-2': 200 });
    });

    it('stores optional note', async () => {
      const doc = await append({ note: 'partial data' });
      expect(doc.note).toBe('partial data');
    });
  });

  describe('newestPerMonthProvider', () => {
    it('returns the newest row per (month, provider)', async () => {
      await append({ internalUsd: 480, deltaUsd: 20, deltaPct: 4 });
      // Later run with updated internal estimate.
      await append({ internalUsd: 490, deltaUsd: 10, deltaPct: 2 });
      await append({
        provider: 'openai',
        providerUsd: 200,
        internalUsd: 195,
        deltaUsd: 5,
        deltaPct: 2.5,
        source: 'openai_usage_api',
      });

      const rows = await spendReconciliationRepository.newestPerMonthProvider();

      expect(rows).toHaveLength(2);
      const anthropic = rows.find(r => r.provider === 'anthropic');
      // Newest row wins.
      expect(anthropic?.internalUsd).toBe(490);
      expect(anthropic?.deltaUsd).toBe(10);
      expect(rows.find(r => r.provider === 'openai')?.providerUsd).toBe(200);
    });
  });

  describe('latestByProvider', () => {
    it('returns the most recent month per provider', async () => {
      await append({ month: '2026-06' });
      await append({ month: '2026-07' });
      await append({
        provider: 'openai',
        month: '2026-07',
        providerUsd: 200,
        internalUsd: 195,
        deltaUsd: 5,
        deltaPct: 2.5,
        source: 'openai_usage_api',
      });

      const rows = await spendReconciliationRepository.latestByProvider();

      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.provider === 'anthropic')?.month).toBe('2026-07');
    });
  });
});
