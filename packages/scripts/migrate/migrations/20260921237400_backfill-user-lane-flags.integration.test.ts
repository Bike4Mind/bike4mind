import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration, { planUserLaneBackfill } from './20260921237400_backfill-user-lane-flags';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await User.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await AdminSettings.collection.insertOne({ settingName: 'syntheticUserEmailDomains', settingValue: 'test.example' });
  vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff.example');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const BEFORE_FLAG = new Date('2026-09-01T00:00:00Z');
const AFTER_FLAG = new Date('2026-10-20T00:00:00Z');

const seed = async (fields: Record<string, unknown>) => {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `u-${_id}`,
    name: 'fixture',
    email: `${_id}@customer.example`,
    ...fields,
  });
  return _id;
};

const flagsOf = async (_id: mongoose.Types.ObjectId) => {
  const row = await User.collection.findOne({ _id }, { projection: { isInternal: 1, isSynthetic: 1 } });
  return { isInternal: row?.isInternal, isSynthetic: row?.isSynthetic };
};

describe('backfill-user-lane-flags', () => {
  it('marks admins and staff-domain accounts internal, and nothing else', async () => {
    const admin = await seed({ isAdmin: true });
    const staff = await seed({ email: 'Alice@Staff.Example' });
    const lookalike = await seed({ email: 'bob@notstaff.example' });
    const subdomain = await seed({ email: 'carol@eu.staff.example' });
    const customer = await seed({});

    await migration.up();

    expect(await flagsOf(admin)).toEqual({ isInternal: true, isSynthetic: undefined });
    expect(await flagsOf(staff)).toEqual({ isInternal: true, isSynthetic: undefined });
    for (const id of [lookalike, subdomain, customer]) {
      expect(await flagsOf(id)).toEqual({ isInternal: undefined, isSynthetic: undefined });
    }
  });

  it('marks persona usernames and test-domain accounts synthetic, whenever they were made', async () => {
    const persona = await seed({ username: 'persona-alpha-1', createdAt: BEFORE_FLAG });
    const upperPersona = await seed({ username: 'Persona-Beta-2', createdAt: BEFORE_FLAG });
    const testDomain = await seed({ email: 'qa@test.example', createdAt: BEFORE_FLAG });
    const testSubdomain = await seed({ email: 'qa@runs.test.example', createdAt: AFTER_FLAG });
    const notPersona = await seed({ username: 'mypersona-1', email: 'qa@nottest.example' });

    await migration.up();

    for (const id of [persona, upperPersona, testDomain, testSubdomain]) {
      expect((await flagsOf(id)).isSynthetic).toBe(true);
    }
    expect(await flagsOf(notPersona)).toEqual({ isInternal: undefined, isSynthetic: undefined });
  });

  it('marks a persona on a staff domain both ways, and leaves already-flagged accounts alone', async () => {
    const both = await seed({ username: 'persona-staff', email: 'p@staff.example' });
    const flagged = await seed({ email: 'd@staff.example', isInternal: true, isSynthetic: false });

    await migration.up();

    expect(await flagsOf(both)).toEqual({ isInternal: true, isSynthetic: true });
    // An explicit isSynthetic: false is not a persona, and an existing flag is not rewritten.
    expect(await flagsOf(flagged)).toEqual({ isInternal: true, isSynthetic: false });
  });

  it('reports what it would mark, by rule, without writing', async () => {
    await seed({ isAdmin: true });
    await seed({ email: 'a@staff.example' });
    await seed({ email: 'b@staff.example' });
    await seed({ username: 'persona-a', createdAt: BEFORE_FLAG });
    await seed({ username: 'persona-b', createdAt: BEFORE_FLAG });
    await seed({ email: 'q@test.example', createdAt: AFTER_FLAG });
    await seed({});

    const plan = await planUserLaneBackfill();

    expect(plan).toMatchObject({
      internal: { admins: 1, staffDomain: 2 },
      synthetic: { persona: 2, testDomain: 1, createdBeforeFlag: 2 },
      staffDomains: 1,
    });
    expect(plan.internal.ids).toHaveLength(3);
    expect(plan.synthetic.ids).toHaveLength(3);
    expect(await User.collection.countDocuments({ $or: [{ isInternal: true }, { isSynthetic: true }] })).toBe(0);
  });

  it('is idempotent: a second run plans and changes nothing', async () => {
    await seed({ isAdmin: true });
    await seed({ username: 'persona-a' });
    await migration.up();
    const log = vi.mocked(console.log);
    log.mockClear();

    const plan = await planUserLaneBackfill();
    await migration.up();

    expect([plan.internal.ids.length, plan.synthetic.ids.length]).toEqual([0, 0]);
    expect(log).toHaveBeenLastCalledWith('[backfill-user-lane-flags] marked 0 account(s) internal and 0 synthetic');
  });

  it('marks admins only, and says so, when no staff domain is configured; no test domain marks personas only', async () => {
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', '');
    await AdminSettings.collection.deleteMany({});
    const admin = await seed({ isAdmin: true });
    const staff = await seed({ email: 'a@staff.example' });
    const testDomain = await seed({ email: 'q@test.example' });
    const persona = await seed({ username: 'persona-x' });

    await migration.up();

    expect((await flagsOf(admin)).isInternal).toBe(true);
    expect((await flagsOf(staff)).isInternal).toBeUndefined();
    expect((await flagsOf(testDomain)).isSynthetic).toBeUndefined();
    expect((await flagsOf(persona)).isSynthetic).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('only admins are marked internal'));
  });
});
