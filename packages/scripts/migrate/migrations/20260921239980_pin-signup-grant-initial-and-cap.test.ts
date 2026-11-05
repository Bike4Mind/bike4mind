import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { resolveSignupGrantSchedule } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20260921239980_pin-signup-grant-initial-and-cap';

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
beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  await AdminSettings.init();
});

const seed = (rows: Record<string, string>) =>
  AdminSettings.insertMany(Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue })));
const value = async (settingName: string) => (await AdminSettings.findOne({ settingName }).lean())?.settingValue;
const repo = { findBySettingName: (settingName: string) => AdminSettings.findOne({ settingName }).lean() } as never;

describe('pin signup grant initial and cap migration', () => {
  it('pins the old flat grant where the schedule rows were never inserted', async () => {
    await seed({ stagedSignupGrantEnabled: 'false', defaultFreeCredits: '500' });
    await migration.up();

    expect([await value('signupGrantInitialCredits'), await value('signupGrantDripCap')]).toEqual(['500', '0']);
    expect(await resolveSignupGrantSchedule(repo)).toMatchObject({ initialCredits: 500, paysFlat: true });
  });

  it('fills an emptied initial credits row from the old fallback and keeps a stored cap', async () => {
    await seed({
      stagedSignupGrantEnabled: 'true',
      signupGrantCredits: '250',
      defaultFreeCredits: '500',
      signupGrantInitialCredits: '',
      signupGrantDripCap: '9000',
    });
    await migration.up();

    expect([await value('signupGrantInitialCredits'), await value('signupGrantDripCap')]).toEqual(['250', '9000']);
  });

  it('leaves stored values alone, including an explicit 0', async () => {
    await seed({ defaultFreeCredits: '500', signupGrantInitialCredits: '0', signupGrantDripCap: '4000' });
    await migration.up();

    expect([await value('signupGrantInitialCredits'), await value('signupGrantDripCap')]).toEqual(['0', '4000']);
  });

  it('pins no cap while staging is on, since the runtime fallback is unchanged there', async () => {
    await seed({ stagedSignupGrantEnabled: 'true', signupGrantCredits: '250' });
    await migration.up();

    expect(await value('signupGrantInitialCredits')).toBe('250');
    expect(await AdminSettings.findOne({ settingName: 'signupGrantDripCap' })).toBeNull();
  });

  it('pins 0 on a fresh install with nothing set, which is what it already paid', async () => {
    await migration.up();
    expect([await value('signupGrantInitialCredits'), await value('signupGrantDripCap')]).toEqual(['0', '0']);
  });
});
