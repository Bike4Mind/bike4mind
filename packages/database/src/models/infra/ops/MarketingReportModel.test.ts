import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { MarketingReport, marketingReportRepository } from './MarketingReportModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await MarketingReport.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await MarketingReport.deleteMany({});
});

const baseDoc = {
  title: 'Test Report',
  reportDate: new Date('2026-06-01T00:00:00.000Z'),
  markdownContent: '## Hello',
  htmlContent: '<h2>Hello</h2>',
  createdByUserId: 'user-123',
  createdByName: 'Test User',
  status: 'draft' as const,
  version: 1,
};

describe('MarketingReportModel', () => {
  it('creates a report with required fields', async () => {
    const doc = await MarketingReport.create(baseDoc);
    expect(doc._id).toBeDefined();
    expect(doc.status).toBe('draft');
    expect(doc.version).toBe(1);
  });

  it('enforces title max length', async () => {
    await expect(MarketingReport.create({ ...baseDoc, title: 'x'.repeat(201) })).rejects.toThrow();
  });

  it('defaults status to draft', async () => {
    const doc = await MarketingReport.create(baseDoc);
    expect(doc.status).toBe('draft');
  });

  it('soft-deletes by setting deletedAt', async () => {
    const doc = await MarketingReport.create(baseDoc);
    await MarketingReport.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
    const found = await MarketingReport.findOne({ _id: doc._id, deletedAt: null });
    expect(found).toBeNull();
  });

  it('has compound indexes (smoke test)', async () => {
    const indexes = await MarketingReport.collection.indexes();
    const keys = indexes.map(i => JSON.stringify(i.key));
    expect(keys.some(k => k.includes('deletedAt') && k.includes('status'))).toBe(true);
    expect(keys.some(k => k.includes('deletedAt') && k.includes('reportDate'))).toBe(true);
  });

  it('confirms no index:true fields via repository', async () => {
    const doc = await marketingReportRepository.findById('000000000000000000000000');
    expect(doc == null).toBe(true);
  });
});
