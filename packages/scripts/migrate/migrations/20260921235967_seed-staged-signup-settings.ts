import { nonnegativeGrantCredits } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import type { MigrationFile } from './index';

const migration: MigrationFile = {
  id: 20260921235967,
  name: 'seed-staged-signup-settings',
  up: async () => {
    const legacy = await AdminSettings.findOne({ settingName: 'defaultFreeCredits' });
    const values = {
      signupGrantCredits: String(nonnegativeGrantCredits(legacy?.settingValue)),
      verifiedUnlockCredits: '0',
      stagedSignupGrantEnabled: 'false',
      signupGrantRiskPolicy: JSON.stringify({ enabled: false }),
      signupGrantActivityEnabled: 'false',
      signupGrantOrgInviteEnabled: 'false',
      signupGrantActivityMinMessages: '0',
      signupGrantActivityMinDays: '0',
    };
    for (const [settingName, settingValue] of Object.entries(values)) {
      await AdminSettings.updateOne({ settingName }, { $setOnInsert: { settingName, settingValue } }, { upsert: true });
    }
  },
  // Preserve settings changed by an operator after migration.
  down: async () => {},
};

export default migration;
