import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { resolveSignupGrantSchedule } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20260921236500_seed-signup-grant-schedule';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AdminSettings.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
// AdminSettings soft-deletes, so deleteMany would leave rows behind the unique settingName index.
beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await AdminSettings.init();
});

const seed = (rows: Record<string, string>) =>
  AdminSettings.insertMany(Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue })));
const stored = async () =>
  Object.fromEntries(
    (
      await AdminSettings.find({
        settingName: {
          $in: [
            'signupGrantInitialCredits',
            'signupGrantDailyCredits',
            'signupGrantDripCap',
            'signupGrantInviteBonusCredits',
          ],
        },
      }).lean()
    ).map(row => [row.settingName, row.settingValue])
  );
const repo = { findBySettingName: (settingName: string) => AdminSettings.findOne({ settingName }).lean() } as never;

describe('seed signup grant schedule migration', () => {
  it('seeds a staged environment with the schedule it already runs', async () => {
    await seed({
      defaultFreeCredits: '10000',
      signupGrantCredits: '1000',
      stagedSignupGrantEnabled: 'true',
      signupGrantActivityEnabled: 'true',
      signupGrantActivityDailyCredits: '1000',
      signupGrantActivityMaxCredits: '9000',
      verifiedUnlockCredits: '9000',
    });
    await migration.up();
    expect(await stored()).toEqual({
      signupGrantInitialCredits: '1000',
      signupGrantDailyCredits: '1000',
      signupGrantDripCap: '9000',
      signupGrantInviteBonusCredits: '0',
    });
    expect(await resolveSignupGrantSchedule(repo)).toMatchObject({ dripCap: 9000, dripCapSource: 'setting' });
  });

  it('seeds a staged-off environment with the flat grant, no drip and no locked remainder', async () => {
    await seed({
      defaultFreeCredits: '500',
      signupGrantCredits: '200',
      verifiedUnlockCredits: '0',
      stagedSignupGrantEnabled: 'false',
      signupGrantActivityEnabled: 'false',
      signupGrantActivityDailyCredits: '1000',
    });
    await migration.up();
    expect(await stored()).toMatchObject({
      signupGrantInitialCredits: '500',
      signupGrantDailyCredits: '0',
      signupGrantDripCap: '0',
    });
  });

  it('takes the smaller legacy cap, keeping a stored 0 as a value', async () => {
    await seed({
      stagedSignupGrantEnabled: true as unknown as string,
      signupGrantActivityMaxCredits: '4000',
      verifiedUnlockCredits: '0',
    });
    await migration.up();
    expect((await stored()).signupGrantDripCap).toBe('0');
  });

  it('keeps the verification unlock when a 0 activity max had the drip off', async () => {
    await seed({
      stagedSignupGrantEnabled: 'true',
      signupGrantActivityEnabled: 'false',
      signupGrantActivityMaxCredits: '0',
      verifiedUnlockCredits: '9000',
    });
    await migration.up();
    expect(await stored()).toMatchObject({ signupGrantDripCap: '9000', signupGrantDailyCredits: '0' });
  });

  it('seeds the default cap for a staged environment with no legacy cap keys', async () => {
    await seed({ stagedSignupGrantEnabled: 'true', signupGrantActivityEnabled: 'true' });
    await migration.up();
    expect(await stored()).toMatchObject({ signupGrantDripCap: '9000', signupGrantDailyCredits: '0' });
  });

  it('seeds every key with no old rows at all', async () => {
    await migration.up();
    expect(await stored()).toMatchObject({ signupGrantDailyCredits: '0', signupGrantDripCap: '0' });
    expect(Number((await stored()).signupGrantInitialCredits)).toBeGreaterThanOrEqual(0);
  });

  it('leaves operator-edited values unchanged on a second run', async () => {
    await seed({ stagedSignupGrantEnabled: 'true', signupGrantActivityEnabled: 'true' });
    await migration.up();
    await AdminSettings.updateOne({ settingName: 'signupGrantDripCap' }, { settingValue: '2500' });
    await AdminSettings.updateOne({ settingName: 'stagedSignupGrantEnabled' }, { settingValue: 'false' });
    await migration.up();
    expect((await stored()).signupGrantDripCap).toBe('2500');
    expect(await AdminSettings.countDocuments({ settingName: 'signupGrantDripCap' })).toBe(1);
  });
});
