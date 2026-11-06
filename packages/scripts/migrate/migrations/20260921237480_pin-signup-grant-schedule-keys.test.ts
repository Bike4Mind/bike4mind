import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration, { PIN_MARKER_COLLECTION } from './20260921237480_pin-signup-grant-schedule-keys';
import { isStoredToggleOn, signupGrantScheduleFromValues, storedGrantCredits } from './legacySignupGrantSchedule';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// The runtime resolver as it read the retired keys, rebuilt from the frozen helper.
async function legacyRuntimeSchedule() {
  const raw = new Map((await AdminSettings.find({}).lean()).map(row => [row.settingName, row.settingValue]));
  return signupGrantScheduleFromValues(
    key => (key === 'defaultFreeCredits' ? undefined : storedGrantCredits(key, raw.get(key))),
    { staged: true, activity: isStoredToggleOn(raw.get('signupGrantActivityEnabled')) }
  );
}

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

const SCHEDULE_KEYS = [
  'signupGrantInitialCredits',
  'signupGrantDailyCredits',
  'signupGrantDripCap',
  'signupGrantInviteBonusCredits',
] as const;

const seed = (rows: Record<string, string>) =>
  AdminSettings.insertMany(Object.entries(rows).map(([settingName, settingValue]) => ({ settingName, settingValue })));
const value = async (settingName: string) => (await AdminSettings.findOne({ settingName }).lean())?.settingValue;
const scheduleValues = async () => Promise.all(SCHEDULE_KEYS.map(value));
const marker = () => mongoose.connection.collection(PIN_MARKER_COLLECTION).findOne({ kind: 'pins' });

// The resolver once the legacy keys are no longer read: only the schedule keys, with registry defaults.
async function simplifiedSchedule() {
  const read = async (key: (typeof SCHEDULE_KEYS)[number]) => storedGrantCredits(key, await value(key));
  const dripCap = (await read('signupGrantDripCap')) ?? 9000;
  return {
    initialCredits: (await read('signupGrantInitialCredits')) ?? 0,
    dailyCredits: (await read('signupGrantDailyCredits')) ?? 0,
    dripCap,
    unlockCredits: dripCap,
    paysFlat: dripCap === 0,
    inviteBonusCredits: (await read('signupGrantInviteBonusCredits')) ?? 0,
  };
}

const SHAPES: [string, Record<string, string>][] = [
  ['empty database', {}],
  [
    'staging off, flat grant already seeded',
    {
      stagedSignupGrantEnabled: 'false',
      defaultFreeCredits: '500',
      signupGrantInitialCredits: '500',
      signupGrantDripCap: '0',
    },
  ],
  [
    'activity drip on',
    {
      signupGrantActivityEnabled: 'true',
      signupGrantActivityDailyCredits: '100',
      signupGrantActivityMaxCredits: '3000',
      verifiedUnlockCredits: '3000',
      signupGrantCredits: '250',
    },
  ],
  [
    'activity drip off with a daily amount stored',
    { signupGrantActivityEnabled: 'false', signupGrantActivityDailyCredits: '100', verifiedUnlockCredits: '1200' },
  ],
  ['activity max unset, unlock below the default cap', { verifiedUnlockCredits: '4000' }],
  ['activity max unset, unlock at the default cap', { verifiedUnlockCredits: '9000' }],
  [
    'blank initial credits row',
    { signupGrantInitialCredits: '', signupGrantCredits: '250', signupGrantDripCap: '700' },
  ],
  [
    'every schedule key already stored',
    {
      signupGrantInitialCredits: '10',
      signupGrantDailyCredits: '20',
      signupGrantDripCap: '30',
      signupGrantInviteBonusCredits: '40',
      verifiedUnlockCredits: '5000',
    },
  ],
];

describe('pin signup grant schedule keys migration', () => {
  it.each(SHAPES)('keeps the schedule unchanged once only schedule keys are read: %s', async (_name, rows) => {
    await seed(rows);
    const { dripCapSource, ...before } = await legacyRuntimeSchedule();
    await migration.up();
    const after = await simplifiedSchedule();

    // A missing cap of 0 locked nothing yet was not flat; one stored cap cannot say both, and nothing is
    // locked either way, so only an invite's up-front share differs.
    const capWasUnset = dripCapSource !== 'setting';
    if (capWasUnset && before.dripCap === 0) {
      expect({ ...after, paysFlat: false }).toEqual(before);
    } else {
      expect(after).toEqual(before);
    }
  });

  it('pins all four keys on an empty database', async () => {
    await migration.up();
    expect(await scheduleValues()).toEqual(['0', '0', '0', '0']);
  });

  it('pins the activity daily amount and an unset-max cap', async () => {
    await seed({
      signupGrantActivityEnabled: 'true',
      signupGrantActivityDailyCredits: '100',
      verifiedUnlockCredits: '4000',
      signupGrantCredits: '250',
    });
    await migration.up();
    expect(await scheduleValues()).toEqual(['250', '100', '4000', '0']);
  });

  it('pins 0 daily credits while the activity toggle is off', async () => {
    await seed({ signupGrantActivityDailyCredits: '100', verifiedUnlockCredits: '1200' });
    await migration.up();
    expect(await value('signupGrantDailyCredits')).toBe('0');
  });

  it('leaves the cap unset where the fallback already equals the default', async () => {
    await seed({ verifiedUnlockCredits: '9000' });
    await migration.up();
    expect(await AdminSettings.findOne({ settingName: 'signupGrantDripCap' })).toBeNull();
  });

  it('writes nothing where every schedule key is stored', async () => {
    await seed({
      signupGrantInitialCredits: '10',
      signupGrantDailyCredits: '20',
      signupGrantDripCap: '30',
      signupGrantInviteBonusCredits: '40',
    });
    await migration.up();
    expect(await scheduleValues()).toEqual(['10', '20', '30', '40']);
    expect(await marker()).toBeNull();
  });

  it('throws before writing anything on a drip/unlock split', async () => {
    await seed({ signupGrantActivityMaxCredits: '2000', verifiedUnlockCredits: '5000', signupGrantCredits: '250' });
    await expect(migration.up()).rejects.toThrow(/signupGrantDripCap/);
    expect(await AdminSettings.countDocuments()).toBe(3);
    expect(await marker()).toBeNull();
  });

  it('is idempotent', async () => {
    await seed({ signupGrantCredits: '250', verifiedUnlockCredits: '4000' });
    await migration.up();
    const first = await scheduleValues();
    const firstMarker = await marker();
    await migration.up();
    expect(await scheduleValues()).toEqual(first);
    expect((await marker())?.pins).toEqual(firstMarker?.pins);
  });

  it('down removes only its own pins that still hold the pinned value', async () => {
    await seed({ signupGrantDripCap: '700', signupGrantCredits: '250' });
    await migration.up();
    expect(await scheduleValues()).toEqual(['250', '0', '700', '0']);
    await AdminSettings.updateOne({ settingName: 'signupGrantDailyCredits' }, { $set: { settingValue: '15' } });

    await migration.down();
    expect(await scheduleValues()).toEqual([undefined, '15', '700', undefined]);
    expect(await value('signupGrantCredits')).toBe('250');
    expect(await marker()).toBeNull();
  });
});
