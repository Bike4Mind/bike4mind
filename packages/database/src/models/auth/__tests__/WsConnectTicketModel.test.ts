import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { WsConnectTicket, wsConnectTicketRepository } from '../WsConnectTicketModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await WsConnectTicket.deleteMany({});
});

const mint = (over: { ticket?: string; expiresAt?: Date } = {}) =>
  wsConnectTicketRepository.create({
    ticket: over.ticket ?? 't-1',
    userId: 'u1',
    tokenVersion: 3,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 30_000),
  });

describe('wsConnectTicketRepository.consume', () => {
  it('resolves the minting identity on first consume', async () => {
    await mint();
    const consumed = await wsConnectTicketRepository.consume('t-1');
    expect(consumed?.userId).toBe('u1');
    expect(consumed?.tokenVersion).toBe(3);
    expect(consumed?.used).toBe(true);
  });

  it('returns null on replay (a ticket consumed twice)', async () => {
    await mint();
    expect(await wsConnectTicketRepository.consume('t-1')).not.toBeNull();
    expect(await wsConnectTicketRepository.consume('t-1')).toBeNull();
  });

  it('rejects an expired ticket', async () => {
    await mint({ expiresAt: new Date(Date.now() - 1000) });
    expect(await wsConnectTicketRepository.consume('t-1')).toBeNull();
  });

  it('returns null for an unknown ticket', async () => {
    expect(await wsConnectTicketRepository.consume('nope')).toBeNull();
  });
});
