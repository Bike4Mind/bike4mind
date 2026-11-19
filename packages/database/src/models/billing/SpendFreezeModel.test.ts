import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import type { SpendFreezeActor, SpendFreezeScope } from '@bike4mind/common';
import { SpendFreeze, spendFreezeRepository } from './SpendFreezeModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await SpendFreeze.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await SpendFreeze.deleteMany({});
});

const newId = () => new mongoose.Types.ObjectId().toString();
const admin: SpendFreezeActor = { kind: 'admin', userId: 'admin-1' };

const freezeInput = (scope: SpendFreezeScope, frozenAt = new Date('2026-11-01T00:00:00.000Z')) => ({
  ...scope,
  reason: 'test',
  actor: admin,
  frozenAt,
});

const liftOf = (liftedAt = new Date('2026-11-02T00:00:00.000Z')) => ({
  liftedBy: admin,
  liftReason: 'resolved',
  liftedAt,
});

describe('SpendFreezeRepository', () => {
  it('rejects a second active freeze on the same scope with a duplicate key error', async () => {
    const scope: SpendFreezeScope = { scopeType: 'User', scopeId: newId() };
    await spendFreezeRepository.createActive(freezeInput(scope));
    await expect(spendFreezeRepository.createActive(freezeInput(scope))).rejects.toMatchObject({ code: 11000 });
  });

  it('allows a new freeze after lifting and lists history newest-first', async () => {
    const scope: SpendFreezeScope = { scopeType: 'Organization', scopeId: newId() };
    await spendFreezeRepository.createActive(freezeInput(scope, new Date('2026-11-01T00:00:00.000Z')));
    const lifted = await spendFreezeRepository.liftActive(scope, liftOf());
    expect(lifted?.liftedAt).toEqual(new Date('2026-11-02T00:00:00.000Z'));
    expect(await spendFreezeRepository.findActive(scope)).toBeNull();

    const second = await spendFreezeRepository.createActive(freezeInput(scope, new Date('2026-11-03T00:00:00.000Z')));
    const { items: history, nextCursor } = await spendFreezeRepository.listHistory(scope, 10);
    expect(nextCursor).toBeNull();
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(second.id);
    expect(history[1].liftReason).toBe('resolved');
  });

  it('liftActive returns null when nothing is active', async () => {
    expect(await spendFreezeRepository.liftActive({ scopeType: 'User', scopeId: newId() }, liftOf())).toBeNull();
  });

  it('findActiveForSubject finds an org freeze and ignores a lifted user freeze', async () => {
    const userId = newId();
    const organizationId = newId();
    await spendFreezeRepository.createActive(freezeInput({ scopeType: 'User', scopeId: userId }));
    await spendFreezeRepository.liftActive({ scopeType: 'User', scopeId: userId }, liftOf());
    const orgFreeze = await spendFreezeRepository.createActive(
      freezeInput({ scopeType: 'Organization', scopeId: organizationId })
    );

    const found = await spendFreezeRepository.findActiveForSubject({ userId, organizationId });
    expect(found?.id).toBe(orgFreeze.id);
    expect(found?.scopeType).toBe('Organization');
  });

  it('findActiveForSubject matches an api key and returns null for an empty subject', async () => {
    const apiKeyId = newId();
    await spendFreezeRepository.createActive(freezeInput({ scopeType: 'apiKey', scopeId: apiKeyId }));
    expect((await spendFreezeRepository.findActiveForSubject({ apiKeyId, userId: null }))?.scopeId).toBe(apiKeyId);
    expect(await spendFreezeRepository.findActiveForSubject({})).toBeNull();
    expect(await spendFreezeRepository.findActiveForSubject({ userId: null, organizationId: undefined })).toBeNull();
  });

  it('findActiveForSubject skips a malformed id and still matches the valid ones', async () => {
    expect(await spendFreezeRepository.findActiveForSubject({ userId: 'not-an-id' })).toBeNull();
    const organizationId = newId();
    const orgFreeze = await spendFreezeRepository.createActive(
      freezeInput({ scopeType: 'Organization', scopeId: organizationId })
    );
    const found = await spendFreezeRepository.findActiveForSubject({ userId: 'not-an-id', organizationId });
    expect(found?.id).toBe(orgFreeze.id);
  });

  it('listHistory pages with a cursor', async () => {
    const scope: SpendFreezeScope = { scopeType: 'User', scopeId: newId() };
    for (let day = 1; day <= 3; day += 1) {
      await spendFreezeRepository.createActive(freezeInput(scope, new Date(`2026-11-0${day}T00:00:00.000Z`)));
      await spendFreezeRepository.liftActive(scope, liftOf(new Date(`2026-11-0${day}T12:00:00.000Z`)));
    }
    const first = await spendFreezeRepository.listHistory(scope, 2);
    expect(first.items.map(i => i.frozenAt.toISOString().slice(0, 10))).toEqual(['2026-11-03', '2026-11-02']);
    const second = await spendFreezeRepository.listHistory(scope, 2, first.nextCursor as string);
    expect(second.items.map(i => i.frozenAt.toISOString().slice(0, 10))).toEqual(['2026-11-01']);
    expect(second.nextCursor).toBeNull();
  });

  it('listActive pages newest-first with nextCursor and filters by scope type', async () => {
    for (let day = 1; day <= 3; day += 1) {
      await spendFreezeRepository.createActive(
        freezeInput({ scopeType: 'User', scopeId: newId() }, new Date(`2026-11-0${day}T00:00:00.000Z`))
      );
    }
    await spendFreezeRepository.createActive(freezeInput({ scopeType: 'apiKey', scopeId: newId() }));

    const first = await spendFreezeRepository.listActive({ scopeType: 'User', limit: 2 });
    expect(first.items.map(item => item.frozenAt.toISOString().slice(0, 10))).toEqual(['2026-11-03', '2026-11-02']);
    expect(first.nextCursor).not.toBeNull();

    const second = await spendFreezeRepository.listActive({
      scopeType: 'User',
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map(item => item.frozenAt.toISOString().slice(0, 10))).toEqual(['2026-11-01']);
    expect(second.nextCursor).toBeNull();
  });
});
