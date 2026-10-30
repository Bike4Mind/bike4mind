import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SignupGrantBudgetDayModel, signupGrantBudgetRepository as repo } from './SignupGrantBudgetModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await SignupGrantBudgetDayModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await SignupGrantBudgetDayModel.deleteMany({});
});

const DAY = '2030-01-01';

describe('signupGrantBudgetRepository', () => {
  it('reserves within the budget', async () => {
    expect(await repo.reserve(DAY, 'tx-1', 10, 25)).toEqual({ spent: 10, fresh: true });
  });

  it('treats a repeated transactionId as not fresh and leaves the spend unchanged', async () => {
    await repo.reserve(DAY, 'tx-1', 10, 25);
    expect(await repo.reserve(DAY, 'tx-1', 10, 25)).toEqual({ spent: 10, fresh: false });
    expect(await repo.getSpent(DAY)).toBe(10);
  });

  it('refuses a reservation that would exceed the budget', async () => {
    await repo.reserve(DAY, 'tx-1', 20, 25);
    expect(await repo.reserve(DAY, 'tx-2', 10, 25)).toBeNull();
    expect(await repo.getSpent(DAY)).toBe(20);
  });

  it('lets concurrent first-of-day reservations all succeed and sum', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd'].map(id => repo.reserve(DAY, id, 5, 100)));
    expect(results.every(r => r !== null)).toBe(true);
    expect(await repo.getSpent(DAY)).toBe(20);
  });

  it('lets a grant larger than the budget draw only on an untouched day', async () => {
    expect(await repo.reserve('2030-01-02', 'big', 30, 10)).toEqual({ spent: 30, fresh: true });
    await repo.reserve('2030-01-03', 'small', 5, 10);
    expect(await repo.reserve('2030-01-03', 'big', 30, 10)).toBeNull();
  });

  it('ignores a refund of an unknown id', async () => {
    await repo.reserve(DAY, 'tx-1', 10, 25);
    await repo.refund(DAY, 'unknown', 10);
    expect(await repo.getSpent(DAY)).toBe(10);
  });

  it('refunds once however many times it is called, and frees the id to reserve again', async () => {
    await repo.reserve(DAY, 'tx-1', 10, 25);
    await repo.refund(DAY, 'tx-1', 10);
    await repo.refund(DAY, 'tx-1', 10);
    expect(await repo.getSpent(DAY)).toBe(0);
    expect(await repo.reserve(DAY, 'tx-1', 10, 25)).toEqual({ spent: 10, fresh: true });
  });

  it('reports 0 spend for a day with no row', async () => {
    expect(await repo.getSpent('2030-12-31')).toBe(0);
  });

  it('marks an alert threshold once', async () => {
    expect(await repo.markAlerted(DAY, 50)).toBe(true);
    expect(await repo.markAlerted(DAY, 50)).toBe(false);
    expect(await repo.markAlerted(DAY, 100)).toBe(true);
  });
});
