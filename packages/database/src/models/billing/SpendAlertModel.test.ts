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

describe('SpendAlertRepository.applyEvaluation', () => {
  const firstWindowEnd = new Date('2026-10-30T12:05:00.000Z');
  const nextWindowEnd = new Date('2026-10-30T12:10:00.000Z');

  it('applies to an incident no run has evaluated yet', async () => {
    const alert = await spendAlertRepository.create(alertFor('u1'));

    const applied = await spendAlertRepository.applyEvaluation({
      id: alert.id,
      clearRuns: 1,
      lastEvaluatedWindowEnd: firstWindowEnd,
    });

    expect(applied).toBe(true);
    expect(await SpendAlert.findById(alert.id).lean()).toMatchObject({
      clearRuns: 1,
      lastEvaluatedWindowEnd: firstWindowEnd,
    });
  });

  it('no-ops when the window was already evaluated, so a retry cannot double-count', async () => {
    const alert = await spendAlertRepository.create(alertFor('u1', { lastEvaluatedWindowEnd: firstWindowEnd }));

    const applied = await spendAlertRepository.applyEvaluation({
      id: alert.id,
      clearRuns: 1,
      lastEvaluatedWindowEnd: firstWindowEnd,
    });

    expect(applied).toBe(false);
    expect(await SpendAlert.findById(alert.id).lean()).toMatchObject({ clearRuns: 0 });
  });

  it('lets exactly one of two overlapping runs apply the same window', async () => {
    const alert = await spendAlertRepository.create(alertFor('u1'));
    const patch = { id: alert.id, clearRuns: 1, lastEvaluatedWindowEnd: firstWindowEnd };

    const results = await Promise.all([
      spendAlertRepository.applyEvaluation(patch),
      spendAlertRepository.applyEvaluation(patch),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('applies a later window and honours unset', async () => {
    const alert = await spendAlertRepository.create(alertFor('u1', { lastEvaluatedWindowEnd: firstWindowEnd }));

    const applied = await spendAlertRepository.applyEvaluation(
      { id: alert.id, status: 'resolved', lastEvaluatedWindowEnd: nextWindowEnd },
      { unset: ['openKey'] }
    );

    expect(applied).toBe(true);
    const stored = await SpendAlert.findById(alert.id).lean();
    expect(stored).toMatchObject({ status: 'resolved', lastEvaluatedWindowEnd: nextWindowEnd });
    expect(stored).not.toHaveProperty('openKey');
  });

  it('no-ops on an incident that resolved since the run read it', async () => {
    const alert = await spendAlertRepository.create(
      alertFor('u1', { status: 'resolved', openKey: undefined, lastEvaluatedWindowEnd: firstWindowEnd })
    );

    const applied = await spendAlertRepository.applyEvaluation({
      id: alert.id,
      severity: 'critical',
      lastEvaluatedWindowEnd: nextWindowEnd,
    });

    expect(applied).toBe(false);
    expect(await SpendAlert.findById(alert.id).lean()).toMatchObject({
      severity: 'warning',
      lastEvaluatedWindowEnd: firstWindowEnd,
    });
  });
});

describe('SpendAlertRepository.recordAutoPause', () => {
  const decision = {
    mode: 'enforce' as const,
    decidedAt: new Date('2026-10-30T12:15:00.000Z'),
    tier: 'standard',
    thresholdCredits: 10_000,
    valueCredits: 12_000,
    freezeId: 'f1',
  };

  it('records the decision once and refuses a second one', async () => {
    const { id } = await spendAlertRepository.create(alertFor('u1'));

    await expect(spendAlertRepository.recordAutoPause(id, decision)).resolves.toBe(true);
    await expect(spendAlertRepository.recordAutoPause(id, { ...decision, mode: 'shadow' })).resolves.toBe(false);
    await expect(spendAlertRepository.recordAutoPause(id, { ...decision, freezeId: 'f2' })).resolves.toBe(false);

    const stored = await spendAlertRepository.findById(id);
    expect(stored?.autoPause).toMatchObject({ mode: 'enforce', freezeId: 'f1', thresholdCredits: 10_000 });
  });

  it('replaces a shadow decision with an enforce one, and not the reverse', async () => {
    const { id } = await spendAlertRepository.create(alertFor('u1'));
    const shadow = { ...decision, mode: 'shadow' as const, freezeId: undefined };

    await expect(spendAlertRepository.recordAutoPause(id, shadow)).resolves.toBe(true);
    await expect(spendAlertRepository.recordAutoPause(id, shadow)).resolves.toBe(false);
    await expect(spendAlertRepository.recordAutoPause(id, decision)).resolves.toBe(true);

    const stored = await spendAlertRepository.findById(id);
    expect(stored?.autoPause).toMatchObject({ mode: 'enforce', freezeId: 'f1' });
  });

  it('no-ops on a resolved incident', async () => {
    const { id } = await spendAlertRepository.create(alertFor('u1', { status: 'resolved', openKey: undefined }));

    await expect(spendAlertRepository.recordAutoPause(id, decision)).resolves.toBe(false);
  });
});
