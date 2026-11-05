import {
  isStoredToggleOn,
  signupGrantScheduleFromValues,
  storedGrantCredits,
  type SignupGrantCreditKey,
} from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';

const READ_KEYS: SignupGrantCreditKey[] = [
  'signupGrantInitialCredits',
  'signupGrantDripCap',
  'signupGrantCredits',
  'defaultFreeCredits',
  'signupGrantActivityMaxCredits',
  'verifiedUnlockCredits',
];

/**
 * The runtime resolver stopped reading defaultFreeCredits and stagedSignupGrantEnabled
 * (runtimeSignupGrantSchedule in b4m-core/common/src/signupGrant.ts). Where the initial credits or drip cap
 * is still absent or empty, pin what the old fallback paid so the amount does not change. Stored values are
 * left alone.
 */
const migration: MigrationFile = {
  id: 20260921239980,
  name: 'pin-signup-grant-initial-and-cap',
  up: async () => {
    const raw = async (settingName: string) => (await AdminSettings.findOne({ settingName }))?.settingValue as unknown;
    const existing = new Set<string>();
    const values = new Map<SignupGrantCreditKey, unknown>();
    for (const key of READ_KEYS) {
      const row = await AdminSettings.findOne({ settingName: key });
      if (row) existing.add(key);
      values.set(key, row?.settingValue);
    }
    const staged = isStoredToggleOn(await raw('stagedSignupGrantEnabled'));
    const legacy = signupGrantScheduleFromValues(key => storedGrantCredits(key, values.get(key)), {
      staged,
      activity: false,
    });
    // With staging on and no cap the runtime already reads the staged fallback, so only staging off pins a cap.
    const pins: [SignupGrantCreditKey, number | undefined][] = [
      ['signupGrantInitialCredits', legacy.initialCredits],
      ['signupGrantDripCap', staged ? undefined : 0],
    ];
    for (const [settingName, value] of pins) {
      if (value === undefined || storedGrantCredits(settingName, values.get(settingName)) !== undefined) continue;
      const settingValue = String(value);
      if (!existing.has(settingName)) {
        await AdminSettings.updateOne(
          { settingName },
          { $setOnInsert: { settingName, settingValue } },
          { upsert: true }
        );
      } else {
        await AdminSettings.updateOne({ settingName }, { $set: { settingValue } });
      }
    }
  },
  // Preserve settings changed by an operator after migration.
  down: async () => {},
};

export default migration;
