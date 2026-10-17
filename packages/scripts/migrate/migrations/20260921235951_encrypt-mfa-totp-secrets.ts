import { User } from '@bike4mind/database';
import { encryptAtRest, isEncrypted, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import { type MigrationFile } from './index';

/**
 * TOTP secrets (`mfa.totpSecret`) are now encrypted at rest by the User schema's write hooks.
 * Rows enrolled before that hold plaintext; findByIdWithMfaSecrets decrypts through
 * `decryptAtRest`, which passes plaintext through unchanged, so MFA keeps working either way and
 * this is the backfill. Already-encrypted rows are skipped, so re-running is a no-op.
 */
const migration: MigrationFile = {
  id: 20260921235951,
  name: 'Encrypt MFA TOTP secrets at rest',

  up: async () => {
    // totpSecret is select:false on the schema, so ask for it explicitly.
    const users = await User.find({ 'mfa.totpSecret': { $exists: true } })
      .select('+mfa.totpSecret')
      .lean<{ _id: unknown; mfa?: { totpSecret?: string } }[]>();

    const pending = users.flatMap(user => {
      const secret = user.mfa?.totpSecret;
      return secret && !isEncrypted(secret) ? [{ id: user._id, secret }] : [];
    });

    if (pending.length === 0) {
      console.log(`No plaintext TOTP secrets to encrypt (${users.length} enrolled users checked)`);
      return;
    }

    // Unlike 20260904000000_encrypt-identity-provider-secrets this does not throw when keyless: a
    // keyless install is a supported posture whose new enrollments are stored plaintext too (see
    // encryptAtRest), and a throw here would block every migration sorted after this one (the
    // invariant BackfillOAuthClientTokenEndpointAuthMethod's test guards). Managed stages always
    // carry the key; a self-host that adds one later re-encrypts as users re-enroll.
    if (!isSecretsAtRestConfigured()) {
      console.warn(
        `SECRET_ENCRYPTION_KEY is not configured; leaving ${pending.length} plaintext TOTP secret(s) unencrypted`
      );
      return;
    }

    let encrypted = 0;
    for (const row of pending) {
      // Conditioned on the plaintext just read, so a concurrent re-enrollment (which writes its own
      // already-encrypted secret) is not overwritten with the stale one.
      const result = await User.updateOne(
        { _id: row.id, 'mfa.totpSecret': row.secret },
        { $set: { 'mfa.totpSecret': encryptAtRest(row.secret) } }
      );
      encrypted += result.modifiedCount;
    }

    console.log(`Encrypted TOTP secrets for ${encrypted} of ${pending.length} plaintext rows`);
  },

  down: async () => {
    // Deliberately not reversible: rewriting second-factor seeds back to plaintext is never the
    // right recovery. Reads accept both forms, so a rollback needs no data change.
    console.log('No rollback: encrypted TOTP secrets stay encrypted (reads accept both forms)');
  },
};

export default migration;
