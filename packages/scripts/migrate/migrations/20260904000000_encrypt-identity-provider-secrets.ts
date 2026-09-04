import { IdentityProviderModel } from '@bike4mind/database';
import { encryptAtRest, isEncrypted, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import { type MigrationFile } from './index';

/**
 * IdP credentials (SAML SP key material and the Okta client secret) are now encrypted at
 * rest. Rows written before this migration hold plaintext; `decryptAtRest` passes those
 * through unchanged, so the app keeps working either way and this is the backfill.
 */
const migration: MigrationFile = {
  id: 20260904000000,
  name: 'Encrypt identity provider secrets at rest',

  up: async () => {
    if (!isSecretsAtRestConfigured()) {
      console.log('No SECRET_ENCRYPTION_KEY configured - skipping IDP secret encryption');
      return;
    }

    // The secret paths are select:false on the schema, so ask for them explicitly.
    const idps = await IdentityProviderModel.find({})
      .select('+samlConfig.decryptionPvk +samlConfig.privateCert +oktaConfig.clientSecret')
      .lean();

    let encrypted = 0;
    for (const idp of idps) {
      // Dotted $set paths, not a nested object: replacing samlConfig/oktaConfig wholesale
      // would drop any field this migration did not read back.
      const update: Record<string, string> = {};
      const candidates: [string, string | undefined][] = [
        ['samlConfig.decryptionPvk', idp.samlConfig?.decryptionPvk],
        ['samlConfig.privateCert', idp.samlConfig?.privateCert],
        ['oktaConfig.clientSecret', idp.oktaConfig?.clientSecret],
      ];

      for (const [path, value] of candidates) {
        if (value && !isEncrypted(value)) {
          update[path] = encryptAtRest(value);
        }
      }

      if (Object.keys(update).length > 0) {
        await IdentityProviderModel.updateOne({ _id: idp._id }, { $set: update });
        encrypted++;
      }
    }

    console.log(`Encrypted secrets on ${encrypted} of ${idps.length} identity providers`);
  },

  down: async () => {
    // Deliberately not reversible: rewriting live credentials back to plaintext is never
    // the right recovery. Reads tolerate both forms, so a rollback needs no data change.
    console.log('No rollback: encrypted IDP secrets stay encrypted (reads accept both forms)');
  },
};

export default migration;
