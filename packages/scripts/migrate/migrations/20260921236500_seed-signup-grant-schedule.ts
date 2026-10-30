import {
  isStoredToggleOn,
  signupGrantScheduleFromValues,
  storedGrantCredits,
  type SignupGrantCreditKey,
} from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';

const LEGACY_KEYS: SignupGrantCreditKey[] = [
  'signupGrantCredits',
  'defaultFreeCredits',
  'signupGrantActivityDailyCredits',
  'signupGrantActivityMaxCredits',
  'verifiedUnlockCredits',
];

/**
 * Seeds the signup grant schedule from the retired toggles so each environment keeps paying what it paid:
 * where staging was off the drip cap is 0 and the initial credits are the flat grant, and where the activity
 * drip was off the daily amount is 0. Values come from the same legacy fallback the runtime resolver uses
 * while the keys are unset (signupGrantScheduleFromValues in b4m-core/common/src/signupGrant.ts).
 */
const migration: MigrationFile = {
  id: 20260921236500,
  name: 'seed-signup-grant-schedule',
  up: async () => {
    const raw = async (settingName: string) => (await AdminSettings.findOne({ settingName }))?.settingValue as unknown;
    const legacy = new Map<SignupGrantCreditKey, number | undefined>();
    for (const key of LEGACY_KEYS) legacy.set(key, storedGrantCredits(key, await raw(key)));
    const schedule = signupGrantScheduleFromValues(key => legacy.get(key), {
      staged: isStoredToggleOn(await raw('stagedSignupGrantEnabled')),
      activity: isStoredToggleOn(await raw('signupGrantActivityEnabled')),
    });
    // A legacy cap of 0 (activity max 0) stopped the drip even with a daily amount set.
    const dripOn = schedule.dailyCredits > 0 && schedule.dripCap > 0;
    const values: Record<string, number | undefined> = {
      signupGrantInitialCredits: schedule.initialCredits,
      signupGrantDailyCredits: dripOn ? schedule.dailyCredits : 0,
      // With no drip the cap only sets what verification releases, so a 0 activity max must not zero it.
      // An activity max below verifiedUnlockCredits splits drip and unlock, which one stored cap cannot hold:
      // leave the cap unset so the resolver's legacy fallback keeps both.
      signupGrantDripCap: !dripOn
        ? schedule.unlockCredits
        : schedule.unlockCredits > schedule.dripCap
          ? undefined
          : schedule.dripCap,
      signupGrantInviteBonusCredits: 0,
    };
    for (const [settingName, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const settingValue = String(value);
      await AdminSettings.updateOne({ settingName }, { $setOnInsert: { settingName, settingValue } }, { upsert: true });
    }
  },
  // Preserve settings changed by an operator after migration.
  down: async () => {},
};

export default migration;
