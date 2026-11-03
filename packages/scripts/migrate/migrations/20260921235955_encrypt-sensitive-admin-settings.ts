import { AdminSettings } from '@bike4mind/database';
import { allSettingDefinitions, SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import { encryptAtRest, isEncrypted, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import { type MigrationFile } from './index';

/**
 * Every `isSensitive` admin setting is encrypted at rest on write (settings/update.ts) and
 * decrypted on read (AdminSettingsModel). The original backfill for rows written before that
 * shipped only as a standalone CLI (packages/scripts/migrate/encrypt-admin-settings-and-apikeys.ts),
 * which the deploy-time migrator never runs, so a stage keeps plaintext secrets until an operator
 * remembers to run it by hand. This is the same backfill as a registered migration, so every
 * stage converges on deploy. Same skip rules as the CLI: string values only, ciphertext left
 * alone (idempotent), and the display mask never persisted as a secret.
 */
const migration: MigrationFile = {
  id: 20260921235955,
  name: 'Encrypt sensitive admin settings at rest',

  up: async () => {
    const sensitiveNames = allSettingDefinitions()
      .filter(def => def.isSensitive === true)
      .map(def => def.key);

    // Raw collection: the model's soft-delete plugin and masking transforms are both bypassed,
    // and a soft-deleted row holding a plaintext secret should still be converted.
    const rows = await AdminSettings.collection.find({ settingName: { $in: sensitiveNames } }).toArray();
    const pending = rows.filter(
      row =>
        typeof row.settingValue === 'string' &&
        row.settingValue !== '' &&
        !row.settingValue.startsWith(SENSITIVE_SETTING_MASK) &&
        !isEncrypted(row.settingValue)
    );

    if (pending.length === 0) {
      console.log(`No plaintext sensitive admin settings to encrypt (${rows.length} sensitive rows checked)`);
      return;
    }

    // Throw rather than return: migrationManager records a non-throwing up() as applied forever,
    // which would leave these rows plaintext permanently. Reached only when there is real
    // plaintext to protect, so a keyless install holding no secrets still deploys.
    if (!isSecretsAtRestConfigured()) {
      throw new Error(
        `SECRET_ENCRYPTION_KEY is not configured but ${pending.length} sensitive admin setting(s) hold plaintext. Configure the key and redeploy; this migration stays pending until it succeeds.`
      );
    }

    let encrypted = 0;
    for (const row of pending) {
      // Match on the value read so an admin save racing this run is never overwritten.
      const res = await AdminSettings.collection.updateOne(
        { _id: row._id, settingValue: row.settingValue },
        { $set: { settingValue: encryptAtRest(row.settingValue as string) } }
      );
      encrypted += res.modifiedCount;
    }
    console.log(
      `Encrypted ${encrypted} of ${pending.length} plaintext sensitive admin setting(s) (${rows.length} checked)`
    );
  },

  down: async () => {
    // Deliberately not reversible: reads accept both forms, so a rollback needs no data change.
    console.log('No rollback: encrypted admin settings stay encrypted (reads accept both forms)');
  },
};

export default migration;
