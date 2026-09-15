import { User } from '@bike4mind/database';
import { mfaService } from '@bike4mind/services';
import { type MigrationFile } from './index';

// Use the canonical hash so this backfill can never diverge from the runtime
// verifyBackupCode path (a divergent local copy would silently produce hashes
// that never match, bricking every migrated user's backup codes).
const { hashBackupCode } = mfaService;

const migration: MigrationFile = {
  id: 20260702000000,
  name: 'hash MFA backup codes at rest',

  up: async () => {
    // Existing backup codes are 10-char uppercase alphanumeric strings.
    // SHA-256 hashes are 64-char lowercase hex strings. Detect un-migrated
    // codes by length (< 64) and hash them in place.
    //
    // backupCodes is select:false, so we must explicitly project it.
    const cursor = User.find({ 'mfa.backupCodes': { $exists: true, $not: { $size: 0 } } })
      .select('+mfa.backupCodes')
      .lean()
      .cursor();

    let migrated = 0;
    let skipped = 0;

    for await (const user of cursor) {
      const codes = (user as any).mfa?.backupCodes as string[] | undefined;
      if (!codes?.length) continue;

      const needsHashing = codes.some(c => c.length < 64);
      if (!needsHashing) {
        skipped++;
        continue;
      }

      const hashed = codes.map(c => (c.length === 64 ? c : hashBackupCode(c)));
      await User.updateOne({ _id: (user as any)._id }, { $set: { 'mfa.backupCodes': hashed } });
      migrated++;
    }

    console.log(`✓ Hashed MFA backup codes: ${migrated} users migrated, ${skipped} already hashed`);
  },

  down: async () => {
    // Intentional no-op - we do not have the plaintext codes after hashing.
    // Any already-migrated user will need to regenerate their backup codes
    // if a rollback is required.
    console.log('⚠ hash-mfa-backup-codes: down migration is a no-op (plaintext codes not recoverable)');
  },
};

export default migration;
