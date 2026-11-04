import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { AdminSettings, CreditTransaction, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { migrateSignupGrantSchedule, parseMigrationArgs } from './migrateSignupGrantSchedule';

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
  await CreditTransaction.collection.deleteMany({});
  await AdminSettings.collection.deleteMany({});
  await AdminSettings.collection.insertOne({ settingName: 'signupGrantDripCap', settingValue: '9000' });
});

const reportDirs: string[] = [];
function reportPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signup-grant-schedule-'));
  reportDirs.push(dir);
  return join(dir, 'report.json');
}
afterAll(() => {
  for (const dir of reportDirs) rmSync(dir, { recursive: true, force: true });
});

const silent = () => undefined;
const oid = () => new mongoose.Types.ObjectId();

const grant = (extra: Record<string, unknown> = {}) => ({
  stage: 'signup',
  signupCredits: 1000,
  unlockCredits: 9000,
  creditsReleased: 1000,
  nextCondition: 'verification',
  ...extra,
});

const insertUser = async (extra: Record<string, unknown> = {}) => {
  const _id = oid();
  await User.collection.insertOne({ _id, username: `u-${_id}`, emailVerified: true, ...extra });
  return _id;
};

const insertLedger = (userId: mongoose.Types.ObjectId, transactionId: string, credits: number) =>
  CreditTransaction.collection.insertOne({
    ownerId: String(userId),
    ownerType: 'User',
    type: 'generic_add',
    transactionId,
    credits,
    createdAt: new Date(),
  });

const grantOf = async (userId: mongoose.Types.ObjectId) =>
  (await User.collection.findOne({ _id: userId }))?.signupGrant as Record<string, unknown> | undefined;

/** A mid-drip account whose state lags the ledger: 1000 tranche + 700 dripped, recorded as only the tranche. */
async function insertLaggingAccount(extra: Record<string, unknown> = {}) {
  const id = await insertUser({ signupGrant: grant(), ...extra });
  await insertLedger(id, `verify-grant:${id}`, 1000);
  await insertLedger(id, `unlock-grant:activity:${id}:2026-11-01`, 400);
  await insertLedger(id, `unlock-grant:activity:${id}:2026-11-02`, 300);
  return id;
}

describe('migrateSignupGrantSchedule', () => {
  it('moves an in-flight account onto the ledger totals and leaves headroom of cap minus dripped', async () => {
    const id = await insertLaggingAccount();

    const result = await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(result.migrated).toBe(1);
    expect(result.changes[0]).toMatchObject({
      userId: String(id),
      before: { creditsReleased: 1000, dripCredits: null },
      after: { creditsReleased: 1700, dripCredits: 700, unlockCredits: 9000 },
      remainingToDrip: 9000 - 700,
    });
    expect(await grantOf(id)).toMatchObject({
      stage: 'signup',
      creditsReleased: 1700,
      dripCredits: 700,
      unlockCredits: 9000,
    });
  });

  it('is a dry run by default and writes nothing', async () => {
    const id = await insertLaggingAccount();
    const before = await User.collection.findOne({ _id: id });

    const result = await migrateSignupGrantSchedule({ reportPath: reportPath(), log: silent });

    expect(result.changes).toHaveLength(1);
    expect(result.migrated).toBe(0);
    expect(await User.collection.findOne({ _id: id })).toEqual(before);
  });

  it('skips flat-grant accounts and leaves them byte-identical', async () => {
    const flat = await insertUser({ currentCredits: 1000 });
    await insertLedger(flat, `verify-grant:${flat}`, 1000);
    const before = await User.collection.findOne({ _id: flat });

    const result = await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(result.skipped.flatGrant).toBe(1);
    expect(result.changes).toHaveLength(0);
    expect(await User.collection.findOne({ _id: flat })).toEqual(before);
  });

  it('skips banned, moderated, disputed, suspended and deleted accounts', async () => {
    const blocked = [
      { isBanned: true },
      { isModerated: true },
      { disputePending: true },
      { moderation: { status: 'suspended' } },
      { deletedAt: new Date() },
    ];
    const ids = [];
    for (const extra of blocked) ids.push(await insertLaggingAccount(extra));

    const result = await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(result.skipped.excluded).toBe(5);
    expect(result.changes).toHaveLength(0);
    for (const id of ids) expect(await grantOf(id)).toMatchObject({ creditsReleased: 1000 });
  });

  it('leaves accounts that are not mid-drip alone', async () => {
    const pending = await insertUser({
      signupGrant: grant({ stage: 'pending_email', creditsReleased: 0, nextCondition: 'email_verification' }),
    });
    const closed = await insertUser({
      signupGrant: grant({ stage: 'unlocked', creditsReleased: 10000, unlockedBy: 'card_verified' }),
    });

    const result = await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(result.inFlight).toBe(0);
    expect(result.skipped.notInFlight).toBe(2);
    expect(await grantOf(pending)).toMatchObject({ stage: 'pending_email', creditsReleased: 0 });
    expect(await grantOf(closed)).toMatchObject({ stage: 'unlocked', creditsReleased: 10000 });
  });

  it('a rerun is a no-op', async () => {
    const id = await insertLaggingAccount();
    const options = { apply: true, maxUsers: 10, maxCredits: 100_000, log: silent };
    await migrateSignupGrantSchedule({ ...options, reportPath: reportPath() });
    const afterFirst = await User.collection.findOne({ _id: id });

    const second = await migrateSignupGrantSchedule({ ...options, reportPath: reportPath() });

    expect(second.changes).toHaveLength(0);
    expect(second.migrated).toBe(0);
    expect(second.skipped['already-aligned']).toBe(1);
    expect(await User.collection.findOne({ _id: id })).toEqual(afterFirst);
  });

  it('refuses to write when more accounts would change than --max-users', async () => {
    const ids = [await insertLaggingAccount(), await insertLaggingAccount()];

    await expect(
      migrateSignupGrantSchedule({
        apply: true,
        maxUsers: 1,
        maxCredits: 1_000_000,
        reportPath: reportPath(),
        log: silent,
      })
    ).rejects.toThrow(/max-users/);

    for (const id of ids) expect(await grantOf(id)).toMatchObject({ creditsReleased: 1000 });
  });

  it('refuses to write when the changed accounts could drip more than --max-credits', async () => {
    const id = await insertLaggingAccount();

    await expect(
      migrateSignupGrantSchedule({ apply: true, maxUsers: 10, maxCredits: 100, reportPath: reportPath(), log: silent })
    ).rejects.toThrow(/max-credits/);

    expect(await grantOf(id)).toMatchObject({ creditsReleased: 1000 });
  });

  it('requires both caps to apply', async () => {
    await expect(migrateSignupGrantSchedule({ apply: true, maxUsers: 10, log: silent })).rejects.toThrow(
      /--apply requires/
    );
    expect(() => parseMigrationArgs(['node', 'x', '--apply', '--max-users', '5'])).toThrow(/--apply requires/);
    expect(parseMigrationArgs(['node', 'x', '--apply', '--max-users=5', '--max-credits', '9'])).toMatchObject({
      apply: true,
      maxUsers: 5,
      maxCredits: 9,
    });
    expect(() => parseMigrationArgs(['node', 'x', '--max-users', '0'])).toThrow(/positive integer/);
  });

  it('never reports negative headroom when the cap sits below what was dripped', async () => {
    await AdminSettings.collection.updateOne({ settingName: 'signupGrantDripCap' }, { $set: { settingValue: '500' } });
    const id = await insertLaggingAccount();

    const result = await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(result.dripCap).toBe(500);
    expect(result.changes[0].remainingToDrip).toBe(0);
    expect(result.remainingToDrip).toBe(0);
    expect(await grantOf(id)).toMatchObject({ dripCredits: 700, creditsReleased: 1700 });
  });

  it('reports an account whose ledger is below its recorded state instead of lowering it', async () => {
    const id = await insertUser({ signupGrant: grant({ creditsReleased: 2000, dripCredits: 1000 }) });
    await insertLedger(id, `verify-grant:${id}`, 1000);

    const result = await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(result.skipped['ledger-below-state']).toBe(1);
    expect(await grantOf(id)).toMatchObject({ creditsReleased: 2000, dripCredits: 1000 });
  });

  it('grows the pool to hold credits already received without paying anything', async () => {
    const id = await insertUser({ signupGrant: grant({ unlockCredits: 100, creditsReleased: 1000 }) });
    await insertLedger(id, `verify-grant:${id}`, 1000);
    await insertLedger(id, `unlock-grant:activity:${id}:2026-11-01`, 600);

    await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(await grantOf(id)).toMatchObject({ creditsReleased: 1600, dripCredits: 600, unlockCredits: 600 });
    expect(await CreditTransaction.collection.countDocuments({ ownerId: String(id) })).toBe(2);
  });

  it('counts only grant ledger rows toward what was received', async () => {
    const id = await insertLaggingAccount();
    await insertLedger(id, `gear-reward:${id}:1`, 5000);
    await insertLedger(id, `purchase:${id}`, 8000);

    await migrateSignupGrantSchedule({
      apply: true,
      maxUsers: 10,
      maxCredits: 100_000,
      reportPath: reportPath(),
      log: silent,
    });

    expect(await grantOf(id)).toMatchObject({ creditsReleased: 1700, dripCredits: 700 });
  });

  it('records every planned change in a 0600 report that is never overwritten', async () => {
    const id = await insertLaggingAccount();
    const path = reportPath();

    await migrateSignupGrantSchedule({ reportPath: path, log: silent });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ userId: String(id), after: { creditsReleased: 1700 } });
    await expect(migrateSignupGrantSchedule({ reportPath: path, log: silent })).rejects.toThrow(/EEXIST/);
  });
});
