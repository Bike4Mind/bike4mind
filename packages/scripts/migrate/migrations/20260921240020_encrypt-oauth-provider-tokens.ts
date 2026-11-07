import { User } from '@bike4mind/database';
import { encryptAtRest, isEncrypted, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import { type MigrationFile } from './index';

type StoredTokens = { strategy?: string; accessToken?: unknown; refreshToken?: unknown; encrypted?: unknown };
type UserTokenRow = { _id: unknown; authProviders?: StoredTokens[]; oauthCredentials?: StoredTokens | null };

const TOKEN_FIELDS = ['accessToken', 'refreshToken'] as const;

const plaintextTokenFilter = (prefix: string) =>
  TOKEN_FIELDS.map(field => ({ [`${prefix}${field}`]: { $type: 'string', $ne: '' } }));

/** The non-empty plaintext token fields of one stored token holder, keyed by field name. */
export function plaintextTokens(holder: StoredTokens | null | undefined): Partial<Record<string, string>> {
  const found: Partial<Record<string, string>> = {};
  if (!holder) return found;
  for (const field of TOKEN_FIELDS) {
    const value = holder[field];
    if (typeof value === 'string' && value !== '' && !isEncrypted(value)) {
      found[field] = value;
    }
  }
  return found;
}

/**
 * Provider sign-in tokens on `authProviders[]` and `oauthCredentials` are now encrypted when
 * written (apps/client/server/utils/auth/providerTokensAtRest.ts). This seals rows written before.
 *
 * Each update is conditioned on the plaintext it read, so a concurrent sign-in that rewrote the
 * entry is left alone rather than overwritten with a stale token.
 *
 * Unlike the IdP backfill this does not throw on a keyless install: keyless installs store these
 * tokens as plaintext by design, and this id sorts below the fail-closed OAuth backfill, so a
 * throw here would block every later migration. On an install that adds a key later, each
 * provider entry is sealed the next time its owner signs in with it.
 */
const migration: MigrationFile = {
  id: 20260921240020,
  name: 'Encrypt OAuth provider sign-in tokens at rest',

  up: async () => {
    if (!isSecretsAtRestConfigured()) {
      console.warn('SECRET_ENCRYPTION_KEY is not configured; OAuth provider tokens stay plaintext on this install');
      return;
    }

    const cursor = User.collection.find(
      {
        $or: [
          { authProviders: { $elemMatch: { encrypted: { $ne: true }, $or: plaintextTokenFilter('') } } },
          { 'oauthCredentials.encrypted': { $ne: true }, $or: plaintextTokenFilter('oauthCredentials.') },
        ],
      },
      { projection: { authProviders: 1, oauthCredentials: 1 } }
    );

    let scanned = 0;
    let sealed = 0;
    for await (const doc of cursor) {
      const row = doc as unknown as UserTokenRow;
      scanned += 1;

      for (const provider of row.authProviders ?? []) {
        const tokens = plaintextTokens(provider);
        if (!provider.strategy || Object.keys(tokens).length === 0) continue;
        const set: Record<string, unknown> = { 'authProviders.$[p].encrypted': true };
        const match: Record<string, unknown> = { 'p.strategy': provider.strategy };
        for (const [field, value] of Object.entries(tokens)) {
          set[`authProviders.$[p].${field}`] = encryptAtRest(value as string);
          match[`p.${field}`] = value;
        }
        const result = await User.collection.updateOne(
          { _id: row._id as never },
          { $set: set },
          { arrayFilters: [match] }
        );
        sealed += result.modifiedCount;
      }

      const credentialTokens = plaintextTokens(row.oauthCredentials);
      if (Object.keys(credentialTokens).length > 0) {
        const set: Record<string, unknown> = { 'oauthCredentials.encrypted': true };
        const filter: Record<string, unknown> = { _id: row._id };
        for (const [field, value] of Object.entries(credentialTokens)) {
          set[`oauthCredentials.${field}`] = encryptAtRest(value as string);
          filter[`oauthCredentials.${field}`] = value;
        }
        const result = await User.collection.updateOne(filter as never, { $set: set });
        sealed += result.modifiedCount;
      }
    }

    console.log(`Sealed ${sealed} OAuth token holder(s) across ${scanned} user(s) with plaintext provider tokens`);
  },

  down: async () => {
    // Not reversible on purpose: reads accept both forms (decryptAtRest passes plaintext through).
    console.log('No rollback: encrypted OAuth provider tokens stay encrypted');
  },
};

export default migration;
