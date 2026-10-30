import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { ISpendAlert, spendAlertOpenKey } from '@bike4mind/common';
import { SpendAlert, spendAlertRepository } from './SpendAlertModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await SpendAlert.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await SpendAlert.deleteMany({});
});

const alertFor = (scopeId: string, overrides: Partial<ISpendAlert> = {}): ISpendAlert => ({
  rule: 'account_spike',
  scopeType: 'User',
  scopeId,
  openKey: spendAlertOpenKey('account_spike', 'User', scopeId),
  status: 'open',
  severity: 'warning',
  openedAt: new Date('2026-10-30T12:00:00.000Z'),
  peakValue: 100,
  lastValue: 100,
  clearRuns: 0,
  context: {},
  ...overrides,
});

describe('SpendAlertRepository', () => {
  it('rejects a second create with the same openKey', async () => {
    await spendAlertRepository.create(alertFor('u1'));

    await expect(spendAlertRepository.create(alertFor('u1'))).rejects.toThrow(/E11000/);
  });

  it('frees the openKey when an update unsets it', async () => {
    const first = await spendAlertRepository.create(alertFor('u1'));

    await spendAlertRepository.update(
      { id: first.id, status: 'resolved', resolvedAt: new Date() },
      { unset: ['openKey'] }
    );

    const stored = await SpendAlert.findById(first.id).lean();
    expect(stored?.status).toBe('resolved');
    expect(stored).not.toHaveProperty('openKey');
    await expect(spendAlertRepository.create(alertFor('u1'))).resolves.toMatchObject({ status: 'open' });
  });

  it('findActive returns open and acknowledged incidents but not resolved ones', async () => {
    await spendAlertRepository.create(alertFor('open'));
    await spendAlertRepository.create(alertFor('acked', { status: 'acknowledged' }));
    await spendAlertRepository.create(alertFor('done', { status: 'resolved', openKey: undefined }));

    const active = await spendAlertRepository.findActive();

    expect(active.map(alert => alert.scopeId).sort()).toEqual(['acked', 'open']);
    expect(active[0]?.id).toEqual(expect.any(String));
  });
});
