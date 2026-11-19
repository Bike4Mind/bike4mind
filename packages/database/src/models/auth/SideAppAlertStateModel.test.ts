import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { SideAppAlertState, sideAppAlertStateRepository as repo } from './SideAppAlertStateModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

describe('side app alert state', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;
  const t0 = new Date('2026-11-18T10:00:00.000Z');

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
    await SideAppAlertState.init();
  });
  beforeEach(async () => {
    await SideAppAlertState.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('lets exactly one of many concurrent opens win', async () => {
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => repo.open('app', 'failing', t0)));
    expect(outcomes.filter(o => o.outcome === 'opened')).toHaveLength(1);
    expect(await SideAppAlertState.countDocuments({ open: true })).toBe(1);
  });

  it('allows the same scope and rule once resolved, and keeps resolved history', async () => {
    const first = await repo.open('app', 'failing', t0);
    if (first.outcome !== 'opened') throw new Error('expected open');
    expect(await repo.resolve(first.id, new Date(t0.getTime() + 1000))).toBe(true);
    expect(await repo.resolve(first.id, new Date(t0.getTime() + 2000))).toBe(false);
    expect((await repo.open('app', 'failing', new Date(t0.getTime() + 3000))).outcome).toBe('opened');
    expect(await SideAppAlertState.countDocuments({})).toBe(2);
    const resolved = await SideAppAlertState.findById(first.id).lean();
    expect(resolved?.open).toBeUndefined();
    expect(resolved?.resolvedAt).toEqual(new Date(t0.getTime() + 1000));
  });

  it('keeps different rules and scopes independent', async () => {
    expect((await repo.open('app', 'failing', t0)).outcome).toBe('opened');
    expect((await repo.open('app', 'silent', t0)).outcome).toBe('opened');
    expect((await repo.open('other', 'failing', t0)).outcome).toBe('opened');
  });

  it('can store an alert without marking it notified', async () => {
    expect((await repo.open('app', 'failing', t0, false)).outcome).toBe('opened');
    const [ref] = await repo.listOpen();
    expect(ref.lastNotifiedAt).toBeUndefined();
    expect(ref.openedAt).toEqual(t0);
  });

  it('grants a notification claim to one caller only, and returns it on release', async () => {
    const opened = await repo.open('app', 'failing', t0);
    if (opened.outcome !== 'opened') throw new Error('expected open');
    const later = new Date(t0.getTime() + 25 * 60 * 60 * 1000);
    const claims = await Promise.all(Array.from({ length: 10 }, () => repo.claimNotification(opened.id, t0, later)));
    expect(claims.filter(Boolean)).toHaveLength(1);

    await repo.releaseClaim(opened.id, later, t0);
    const [ref] = await repo.listOpen();
    expect(ref.lastNotifiedAt).toEqual(t0);
  });

  it('unsets lastNotifiedAt when a first send is released, so the next run sends it', async () => {
    const opened = await repo.open('app', 'failing', t0);
    if (opened.outcome !== 'opened') throw new Error('expected open');
    await repo.releaseClaim(opened.id, t0, undefined);
    const [ref] = await repo.listOpen();
    expect(ref.lastNotifiedAt).toBeUndefined();
    expect(await repo.claimNotification(opened.id, undefined, t0)).toBe(true);
    expect(await repo.claimNotification(opened.id, undefined, t0)).toBe(false);
  });
});
