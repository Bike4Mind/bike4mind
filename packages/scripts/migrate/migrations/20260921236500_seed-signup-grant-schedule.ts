import { settingsMap, storedGrantCredits, type SignupGrantCreditKey } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';

/**
 * Seeds the signup grant schedule from the retired toggles so each environment keeps paying what it paid:
 * where staging was off the drip cap is 0 and the initial credits are the flat grant, and where the activity
 * drip was off the daily amount is 0. The legacy cap mirrors signupGrantScheduleFromValues in
 * b4m-core/common/src/signupGrant.ts.
 */
const migration: MigrationFile = {
  id: 20260921236500,
  name: 'seed-signup-grant-schedule',
  up: async () => {
    const raw = async (settingName: string) => (await AdminSettings.findOne({ settingName }))?.settingValue as unknown;
    const credits = async (key: SignupGrantCreditKey) => storedGrantCredits(key, await raw(key));
    const isOn = (value: unknown) => value === 'true' || value === true;

    const stagedOn = isOn(await raw('stagedSignupGrantEnabled'));
    const activityOn = isOn(await raw('signupGrantActivityEnabled'));
    const flatGrant = (await credits('defaultFreeCredits')) ?? settingsMap.defaultFreeCredits.defaultValue ?? 0;
    const legacyCaps = [await credits('signupGrantActivityMaxCredits'), await credits('verifiedUnlockCredits')].filter(
      (value): value is number => value !== undefined
    );
    const values = {
      signupGrantInitialCredits: stagedOn ? ((await credits('signupGrantCredits')) ?? flatGrant) : flatGrant,
      signupGrantDailyCredits: activityOn ? ((await credits('signupGrantActivityDailyCredits')) ?? 0) : 0,
      signupGrantDripCap: stagedOn
        ? legacyCaps.length
          ? Math.min(...legacyCaps)
          : (settingsMap.signupGrantDripCap.defaultValue ?? 0)
        : 0,
      signupGrantInviteBonusCredits: 0,
    };
    for (const [settingName, value] of Object.entries(values)) {
      const settingValue = String(value);
      await AdminSettings.updateOne({ settingName }, { $setOnInsert: { settingName, settingValue } }, { upsert: true });
    }
  },
  // Preserve settings changed by an operator after migration.
  down: async () => {},
};

export default migration;
