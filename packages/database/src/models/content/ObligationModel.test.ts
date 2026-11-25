import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { ObligationModel, obligationDayToDate, obligationRepository, type ObligationInput } from './ObligationModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await settleAutoIndexBuilds(mongoose);
  await ObligationModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await ObligationModel.deleteMany({});
});

const invoice = (overrides: Partial<ObligationInput> = {}): ObligationInput => ({
  userId: 'user-me',
  fileId: 'file-1',
  documentKind: 'invoice',
  amountValue: 184.37,
  currency: 'USD',
  payee: 'Acme Water Utility',
  dueDate: obligationDayToDate('2026-12-04'),
  destinationLakeId: 'lake-1',
  destinationName: 'Household bills',
  summary: 'Water bill for October service.',
  model: 'test-model',
  ...overrides,
});

async function confirmed(overrides: Partial<ObligationInput>) {
  const { obligation } = await obligationRepository.create(invoice(overrides));
  await obligationRepository.applyUpdate(obligation._id.toString(), obligation.userId, {
    status: 'confirmed',
    confirmedAt: new Date(),
  });
  return obligation._id.toString();
}

describe('obligationRepository.create', () => {
  it('round-trips an invoice-shaped row that only its owner can read', async () => {
    const { obligation, created } = await obligationRepository.create(invoice());
    expect(created).toBe(true);
    expect(obligation).toMatchObject({ status: 'pending', amountValue: 184.37, currency: 'USD', confirmedAt: null });

    const id = obligation._id.toString();
    expect(await obligationRepository.findByIdForUser(id, 'user-me')).toMatchObject({ payee: 'Acme Water Utility' });
    expect(await obligationRepository.findByIdForUser(id, 'user-other')).toBeNull();
    expect(await obligationRepository.findByIdForUser('not-an-id', 'user-me')).toBeNull();
    expect((await obligationRepository.findByFileForUser('file-1', 'user-me'))?._id.toString()).toBe(id);
    expect(await obligationRepository.findByFileForUser('file-1', 'user-other')).toBeNull();
  });

  it('returns the existing row for a second hand-off of the same file', async () => {
    const first = await obligationRepository.create(invoice());
    const second = await obligationRepository.create(invoice({ payee: 'Someone else' }));
    expect(second.created).toBe(false);
    expect(second.obligation._id.toString()).toBe(first.obligation._id.toString());
    expect(second.obligation.payee).toBe('Acme Water Utility');
    expect(await ObligationModel.countDocuments({})).toBe(1);
  });

  it('lets another user hand off a file with the same id', async () => {
    await obligationRepository.create(invoice());
    const other = await obligationRepository.create(invoice({ userId: 'user-other' }));
    expect(other.created).toBe(true);
  });

  it('rejects a negative amount and a lower-case currency', async () => {
    await expect(obligationRepository.create(invoice({ amountValue: -1 }))).rejects.toThrow();
    await expect(obligationRepository.create(invoice({ fileId: 'file-2', currency: 'usd' }))).rejects.toThrow();
  });
});

describe('obligationRepository.applyUpdate', () => {
  it('updates only the owner row and validates the new values', async () => {
    const { obligation } = await obligationRepository.create(invoice());
    const id = obligation._id.toString();
    expect(await obligationRepository.applyUpdate(id, 'user-other', { payee: 'x' })).toBeNull();
    expect(await obligationRepository.applyUpdate(id, 'user-me', { payee: 'Acme Water' })).toMatchObject({
      payee: 'Acme Water',
    });
    await expect(obligationRepository.applyUpdate(id, 'user-me', { amountValue: -3 })).rejects.toThrow();
  });

  it('leaves a dismissed row unchanged', async () => {
    const { obligation } = await obligationRepository.create(invoice());
    const id = obligation._id.toString();
    await obligationRepository.applyUpdate(id, 'user-me', { status: 'dismissed' });
    expect(await obligationRepository.applyUpdate(id, 'user-me', { status: 'confirmed' })).toBeNull();
    expect(await obligationRepository.findByIdForUser(id, 'user-me')).toMatchObject({ status: 'dismissed' });
  });
});

describe('obligationRepository.listForUser', () => {
  it('pages newest first, filters by status and ignores other users', async () => {
    const ids: string[] = [];
    for (const fileId of ['a', 'b', 'c']) {
      ids.push((await obligationRepository.create(invoice({ fileId }))).obligation._id.toString());
    }
    await obligationRepository.create(invoice({ userId: 'user-other', fileId: 'z' }));
    await obligationRepository.applyUpdate(ids[0], 'user-me', { status: 'dismissed' });

    const page1 = await obligationRepository.listForUser('user-me', { limit: 2 });
    expect(page1.map(o => o._id.toString())).toEqual([ids[2], ids[1]]);
    const page2 = await obligationRepository.listForUser('user-me', { limit: 2, cursor: ids[1] });
    expect(page2.map(o => o._id.toString())).toEqual([ids[0]]);
    const pending = await obligationRepository.listForUser('user-me', { limit: 10, status: 'pending' });
    expect(pending.map(o => o._id.toString())).toEqual([ids[2], ids[1]]);
  });

  it('reads nothing for a malformed id and treats a malformed cursor as the first page', async () => {
    const { obligation } = await obligationRepository.create(invoice());
    expect(await obligationRepository.findByIdForUser('not-an-id', 'user-me')).toBeNull();
    expect(await obligationRepository.applyUpdate('not-an-id', 'user-me', { payee: 'X' })).toBeNull();
    const page = await obligationRepository.listForUser('user-me', { limit: 5, cursor: 'garbage' });
    expect(page.map(o => o._id.toString())).toEqual([obligation._id.toString()]);
  });
});

describe('obligationRepository.listDueForBrief', () => {
  it('returns confirmed rows due inside the window only, soonest first', async () => {
    const inside = await confirmed({ fileId: 'in', dueDate: obligationDayToDate('2026-12-04') });
    const fromEdge = await confirmed({ fileId: 'from', dueDate: obligationDayToDate('2026-12-01') });
    const toEdge = await confirmed({ fileId: 'to', dueDate: obligationDayToDate('2026-12-08') });
    await confirmed({ fileId: 'before', dueDate: obligationDayToDate('2026-11-30') });
    await confirmed({ fileId: 'after', dueDate: obligationDayToDate('2026-12-09') });
    await confirmed({ fileId: 'undated', dueDate: null });
    await confirmed({ fileId: 'theirs', userId: 'user-other', dueDate: obligationDayToDate('2026-12-04') });
    await obligationRepository.create(invoice({ fileId: 'pending', dueDate: obligationDayToDate('2026-12-04') }));
    const dismissed = await confirmed({ fileId: 'dismissed', dueDate: obligationDayToDate('2026-12-04') });
    await obligationRepository.applyUpdate(dismissed, 'user-me', { status: 'dismissed' });

    const due = await obligationRepository.listDueForBrief('user-me', '2026-12-01', '2026-12-08', 12);
    expect(due.map(o => o._id.toString())).toEqual([fromEdge, inside, toEdge]);

    const capped = await obligationRepository.listDueForBrief('user-me', '2026-12-01', '2026-12-08', 1);
    expect(capped.map(o => o._id.toString())).toEqual([fromEdge]);
  });
});
