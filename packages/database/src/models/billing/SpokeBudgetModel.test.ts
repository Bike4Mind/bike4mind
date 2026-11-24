import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongoServer } from '../../__test__/createMongoServer';
import { SpokeBudgetModel, SpokeBudgetRepository } from './SpokeBudgetModel';

describe('SpokeBudgetRepository', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  let now = new Date('2025-01-31T23:59:00Z');
  const repository = new SpokeBudgetRepository(() => now);
  const limits = { daily: 100, monthly: 150, userDaily: 60, userMonthly: 90 };
  const reserve = (requestId: string, amount = 30, userId = 'user-a', clientId = 'client-a') =>
    repository.reserve({ clientId, userId, requestId, amount, limits });
  const settle = (requestId: string, charged: number, userId = 'user-a') =>
    repository.settle({ clientId: 'client-a', userId, requestId, charged });

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await SpokeBudgetModel.init();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    now = new Date('2025-01-31T23:59:00Z');
    await SpokeBudgetModel.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });

  it('isolates clients and users while enforcing shared ceilings', async () => {
    expect(await reserve('r1', 60)).toBe('reserved');
    expect(await reserve('r2', 1)).toBe('budget_exceeded');
    expect(await reserve('r3', 40, 'user-b')).toBe('reserved');
    expect(await reserve('r4', 1, 'user-c')).toBe('budget_exceeded');
    expect(await reserve('r1', 60, 'user-a', 'client-b')).toBe('reserved');
  });

  it('does not oversubscribe under concurrent admissions', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reserve(`r${i}`, 30)));
    expect(results.filter(result => result === 'reserved')).toHaveLength(2);
    expect(results.filter(result => result === 'budget_exceeded')).toHaveLength(6);
  });

  it('makes concurrent duplicate reservations and settlements idempotent', async () => {
    await Promise.all(Array.from({ length: 6 }, () => reserve('same', 60)));
    await Promise.all(Array.from({ length: 6 }, () => settle('same', 20)));
    expect(await reserve('same', 60)).toBe('settled');
    expect(await reserve('next', 40)).toBe('reserved');
    expect((await SpokeBudgetModel.findById('client-a'))?.reservations).toHaveLength(2);
  });

  it('releases confirmed zero-cost failures without reopening the request', async () => {
    await reserve('failed', 60);
    await settle('failed', 0);
    await settle('failed', 0);
    expect(await reserve('failed', 60)).toBe('settled');
    expect(await reserve('next', 60)).toBe('reserved');
    await expect(settle('failed', 1)).rejects.toThrow('Settlement mismatch');
  });

  it('retains unknown-cost holds across process instances', async () => {
    await reserve('pending', 60);
    const restarted = new SpokeBudgetRepository(() => now);
    expect(
      await restarted.reserve({ clientId: 'client-a', userId: 'user-a', requestId: 'new', amount: 1, limits })
    ).toBe('budget_exceeded');
  });

  it('enforces monthly limits after a UTC day rollover', async () => {
    now = new Date('2025-01-30T23:59:59Z');
    await reserve('day1', 60);
    now = new Date('2025-01-31T00:00:00Z');
    expect(await reserve('day2', 30)).toBe('reserved');
    expect(await reserve('day2-extra', 1)).toBe('budget_exceeded');
    await reserve('other', 60, 'user-b');
    expect(await reserve('monthly-extra', 1, 'user-c')).toBe('budget_exceeded');
  });

  it('settles against original windows after rollover and preserves retry bindings', async () => {
    await reserve('old', 60);
    now = new Date('2025-02-01T00:00:00Z');
    await settle('old', 20);
    expect(await reserve('new', 60)).toBe('reserved');
    expect(await reserve('old', 60)).toBe('settled');
    expect(await reserve('extra', 1)).toBe('budget_exceeded');
  });

  it('rejects rebinding, overages, negative amounts and unknown settlements', async () => {
    await reserve('bound', 30);
    await expect(reserve('bound', 31)).rejects.toThrow('binding mismatch');
    await expect(reserve('bound', 30, 'user-b')).rejects.toThrow('binding mismatch');
    await expect(settle('bound', 31)).rejects.toThrow('exceeds reservation');
    await expect(settle('bound', -1)).rejects.toThrow('Invalid budget amount');
    await expect(settle('missing', 0)).rejects.toThrow('Unknown reservation');
    await expect(settle('bound', 0, 'user-b')).rejects.toThrow('Unknown reservation');
    for (const amount of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(reserve('invalid', amount)).rejects.toThrow();
    }
  });

  it('denies missing or zero ceilings and invalid identifiers', async () => {
    await expect(
      repository.reserve({ clientId: 'c', userId: 'u', requestId: 'r', amount: 1, limits: { ...limits, daily: NaN } })
    ).rejects.toThrow('Invalid budget amount');
    expect(
      await repository.reserve({
        clientId: 'c',
        userId: 'u',
        requestId: 'r',
        amount: 1,
        limits: { ...limits, daily: 0 },
      })
    ).toBe('budget_exceeded');
    await expect(reserve('$invalid')).rejects.toThrow('Invalid budget identifier');
  });

  it('fails closed when storage fails', async () => {
    vi.spyOn(SpokeBudgetModel, 'create').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(reserve('r')).rejects.toThrow('storage unavailable');
    expect(await SpokeBudgetModel.countDocuments()).toBe(0);
  });

  it('keeps validated ceilings stable while database I/O is pending', async () => {
    const mutableLimits = { ...limits, daily: 0 };
    const admission = repository.reserve({
      clientId: 'client-a',
      userId: 'user-a',
      requestId: 'r',
      amount: 1,
      limits: mutableLimits,
    });
    mutableLimits.daily = NaN;
    expect(await admission).toBe('budget_exceeded');
  });

  it('enforces windows for UTC years below 100 and rejects an invalid clock', async () => {
    now = new Date('0099-01-31T23:59:00Z');
    expect(await reserve('first', 60)).toBe('reserved');
    expect(await reserve('second', 1)).toBe('budget_exceeded');
    now = new Date(NaN);
    await expect(reserve('invalid-clock', 1)).rejects.toThrow('Invalid budget clock');
    expect((await SpokeBudgetModel.findById('client-a'))?.reservations).toHaveLength(1);
  });

  it('rejects invalid identifiers and ceilings without writing', async () => {
    for (const invalid of ['', 'r\n', 'r\r', 'a'.repeat(129), '$invalid']) {
      await expect(reserve(invalid)).rejects.toThrow('Invalid budget identifier');
      await expect(reserve('r', 1, invalid)).rejects.toThrow('Invalid budget identifier');
      await expect(reserve('r', 1, 'user-a', invalid)).rejects.toThrow('Invalid budget identifier');
    }
    for (const field of ['daily', 'monthly', 'userDaily', 'userMonthly'] as const) {
      for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(
          repository.reserve({
            clientId: 'client-a',
            userId: 'user-a',
            requestId: 'r',
            amount: 1,
            limits: { ...limits, [field]: invalid },
          })
        ).rejects.toThrow('Invalid budget amount');
      }
    }
    expect(await SpokeBudgetModel.countDocuments()).toBe(0);
  });

  it('fails closed on read and replacement failures without releasing a hold', async () => {
    await reserve('held', 60);
    vi.spyOn(SpokeBudgetModel, 'findById').mockImplementationOnce(() => {
      throw new Error('read unavailable');
    });
    await expect(reserve('read-failure', 1)).rejects.toThrow('read unavailable');
    vi.spyOn(SpokeBudgetModel, 'replaceOne').mockImplementationOnce(() => {
      throw new Error('write unavailable');
    });
    await expect(settle('held', 0)).rejects.toThrow('write unavailable');
    expect(await reserve('next', 1)).toBe('budget_exceeded');
    expect(await reserve('held', 60)).toBe('reserved');
  });

  it('fails closed after bounded CAS contention without overwriting newer data', async () => {
    await reserve('held', 30);
    const query = SpokeBudgetModel.replaceOne({ _id: 'absent' }, { revision: 1 });
    const exec = vi.spyOn(query, 'exec').mockResolvedValue({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    });
    vi.spyOn(SpokeBudgetModel, 'replaceOne').mockReturnValue(query);
    await expect(reserve('contended', 1)).rejects.toThrow('Budget contention');
    expect(exec).toHaveBeenCalledTimes(16);
    expect((await SpokeBudgetModel.findById('client-a'))?.reservations).toHaveLength(1);
  });

  it('allows only one competing settlement value to win', async () => {
    await reserve('held', 60);
    const outcomes = await Promise.allSettled([settle('held', 10), settle('held', 20)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.message).toBe('Settlement mismatch');
    const budget = await SpokeBudgetModel.findById('client-a');
    expect([10, 20]).toContain(budget?.reservations[0]?.charged);
    expect(budget?.reservations[0]?.state).toBe('settled');
  });

  it('does not round an over-limit sum into an admission', async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const hugeLimits = { daily: maximum, monthly: maximum, userDaily: maximum, userMonthly: maximum };
    expect(
      await repository.reserve({
        clientId: 'client-a',
        userId: 'user-a',
        requestId: 'huge',
        amount: maximum,
        limits: hugeLimits,
      })
    ).toBe('reserved');
    expect(
      await repository.reserve({
        clientId: 'client-a',
        userId: 'user-b',
        requestId: 'extra',
        amount: 1,
        limits: hugeLimits,
      })
    ).toBe('budget_exceeded');
  });

  it('serializes admissions at the lifetime capacity boundary and still permits settlement', async () => {
    await SpokeBudgetModel.create({
      _id: 'client-a',
      revision: 0,
      reservations: Array.from({ length: 1023 }, (_, i) => ({
        requestId: `old${i}`,
        userId: 'user-a',
        reserved: 1,
        charged: 0,
        createdAt: now,
        state: 'settled',
      })),
    });
    const outcomes = await Promise.all([reserve('last-a', 1), reserve('last-b', 1)]);
    expect([...outcomes].sort()).toEqual(['capacity_exceeded', 'reserved']);
    const budget = await SpokeBudgetModel.findById('client-a');
    const active = budget?.reservations.find(row => row.state === 'reserved');
    expect(budget?.reservations).toHaveLength(1024);
    if (!active) throw new Error('Expected an active reservation');
    await settle(active.requestId, 0);
    expect(await reserve(active.requestId, 1)).toBe('settled');
    expect(await reserve('overflow', 1)).toBe('capacity_exceeded');
  });

  it('bounds record size without discarding terminal retry protection', async () => {
    await SpokeBudgetModel.create({
      _id: 'client-a',
      revision: 0,
      reservations: Array.from({ length: 1024 }, (_, i) => ({
        requestId: `r${i}`,
        userId: 'user-a',
        reserved: 1,
        charged: 0,
        createdAt: now,
        state: 'settled',
      })),
    });
    expect(await reserve('overflow', 1)).toBe('capacity_exceeded');
    expect(await reserve('r0', 1)).toBe('settled');
  });
});
