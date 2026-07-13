import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ProviderInvoice, providerInvoiceRepository } from './ProviderInvoiceModel';
import { IProviderInvoiceInput } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await ProviderInvoice.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await ProviderInvoice.deleteMany({});
});

const baseRow: IProviderInvoiceInput = {
  month: '2026-06',
  provider: 'openai',
  invoiceUsd: 412.3,
  note: 'INV-1, Jun 1-30',
  enteredBy: 'admin-1',
};

const append = (overrides: Partial<IProviderInvoiceInput> = {}) =>
  providerInvoiceRepository.append({ ...baseRow, ...overrides });

describe('ProviderInvoiceRepository', () => {
  describe('append', () => {
    it('persists a row with timestamps', async () => {
      const doc = await append();
      expect(doc.invoiceUsd).toBe(412.3);
      expect(doc.createdAt).toBeInstanceOf(Date);
    });

    it('rejects a malformed month', async () => {
      await expect(append({ month: '2026-6' })).rejects.toThrow();
      await expect(append({ month: 'June 2026' })).rejects.toThrow();
    });

    it('rejects negative and non-finite amounts', async () => {
      await expect(append({ invoiceUsd: -1 })).rejects.toThrow();
      await expect(append({ invoiceUsd: Number.NaN })).rejects.toThrow();
    });

    it('rejects an empty note', async () => {
      await expect(append({ note: '' })).rejects.toThrow();
    });

    it('is idempotent: same amount and note returns the existing row', async () => {
      const first = await append();
      const second = await append();
      expect(second.id).toBe(first.id);
      expect(await ProviderInvoice.countDocuments()).toBe(1);
    });

    it('appends a correction as a new row', async () => {
      await append();
      const corrected = await append({ invoiceUsd: 400, note: 'INV-1 corrected, credit memo CM-2' });
      expect(corrected.invoiceUsd).toBe(400);
      expect(await ProviderInvoice.countDocuments()).toBe(2);
    });
  });

  describe('newestPerMonthProvider', () => {
    it('returns the newest row per (month, provider)', async () => {
      await append();
      // Corrections win over the original; other keys are independent.
      await append({ invoiceUsd: 400, note: 'INV-1 corrected' });
      await append({ provider: 'anthropic', invoiceUsd: 990, note: 'INV-A' });
      await append({ month: '2026-05', invoiceUsd: 380, note: 'INV-0' });

      const rows = await providerInvoiceRepository.newestPerMonthProvider();

      expect(rows).toHaveLength(3);
      const jun = rows.find(r => r.month === '2026-06' && r.provider === 'openai');
      expect(jun?.invoiceUsd).toBe(400);
      expect(rows.find(r => r.provider === 'anthropic')?.invoiceUsd).toBe(990);
      expect(rows.find(r => r.month === '2026-05')?.invoiceUsd).toBe(380);
    });
  });
});
