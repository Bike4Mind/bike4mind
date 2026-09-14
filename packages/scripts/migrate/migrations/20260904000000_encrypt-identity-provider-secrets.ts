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
    // The secret paths are select:false on the schema, so ask for them explicitly.
    const idps = await IdentityProviderModel.find({})
      .select('+samlConfig.decryptionPvk +samlConfig.privateCert +oktaConfig.clientSecret')
      .lean();

    // Dotted $set paths, not a nested object: replacing samlConfig/oktaConfig wholesale
    // would drop any field this migration did not read back.
    const pending = idps
      .map(idp => {
        const plaintext: Record<string, string> = {};
        const candidates: [string, string | undefined][] = [
          ['samlConfig.decryptionPvk', idp.samlConfig?.decryptionPvk],
          ['samlConfig.privateCert', idp.samlConfig?.privateCert],
          ['oktaConfig.clientSecret', idp.oktaConfig?.clientSecret],
        ];
        for (const [path, value] of candidates) {
          if (value && !isEncrypted(value)) {
            plaintext[path] = value;
          }
        }
        return { id: idp._id, plaintext };
      })
      .filter(row => Object.keys(row.plaintext).length > 0);

    if (pending.length === 0) {
      console.log(`No plaintext IDP secrets to encrypt (${idps.length} identity providers checked)`);
      return;
    }

    // Throw rather than log-and-return: migrationManager records any non-throwing up() as
    // applied and never reconsiders it, so returning here would mark the backfill done and
    // leave these secrets plaintext at rest permanently. Failing keeps the migration
    // pending until a key exists, which is the recoverable state. Reached only when there
    // is real plaintext to protect - a keyless install storing no secrets is a supported
    // posture (see encryptAtRest) and returns above rather than blocking its deploy.
    if (!isSecretsAtRestConfigured()) {
      throw new Error(
        `SECRET_ENCRYPTION_KEY is not configured but ${pending.length} identity provider(s) hold plaintext secrets. Configure the key and re-run; this migration stays pending until it succeeds.`
      );
    }

    for (const row of pending) {
      const update: Record<string, string> = {};
      for (const [path, value] of Object.entries(row.plaintext)) {
        update[path] = encryptAtRest(value);
      }
      await IdentityProviderModel.updateOne({ _id: row.id }, { $set: update });
    }

    console.log(`Encrypted secrets on ${pending.length} of ${idps.length} identity providers`);
  },

  down: async () => {
    // Deliberately not reversible: rewriting live credentials back to plaintext is never
    // the right recovery. Reads tolerate both forms, so a rollback needs no data change.
    console.log('No rollback: encrypted IDP secrets stay encrypted (reads accept both forms)');
  },
};

export default migration;
