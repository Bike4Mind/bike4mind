import { OAuthClientModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[backfill-oauthclient-token-endpoint-auth-method]';

/**
 * Backfill `tokenEndpointAuthMethod: 'client_secret_post'` for every OAuth client that predates the
 * field, so existing confidential integrations keep working once the hardened token endpoint ships.
 *
 * The endpoint now keys the confidential-vs-public decision on this field, not on whether a secret
 * was sent: a client without it is treated as public and rejected unless it presents PKCE. Every
 * legacy row was registered by `seed-oauth-client.ts`, which always mints a client_secret - so every
 * field-less row is confidential and would otherwise start failing its code exchange on deploy.
 *
 * Scoped to `{ $exists: false }` so it only touches un-classified legacy rows: a client already
 * classified (e.g. the preview `none` public client the seeder provisions explicitly) is left alone.
 * Idempotent - a re-run finds nothing once the field is populated.
 *
 * PRECONDITION (deploy runbook, not enforceable from the diff): a legacy client that was registered
 * with a secret but authenticates PKCE-only would be wrongly stamped confidential here and then fail
 * its next code exchange with 401. Minting a secret is not the same as presenting one, and that is
 * only answerable against the live `oauthclients` collection. Before this runs, audit it and set
 * `tokenEndpointAuthMethod: 'none'` explicitly on any PKCE-only client; the `$exists: false` guard
 * then leaves those rows untouched. Run this ahead of promoting the token-endpoint code so there is
 * no window where the hardened handler is live but legacy rows are still un-classified.
 */
const migration: MigrationFile = {
  id: 20260912000000,
  name: 'backfill-oauthclient-token-endpoint-auth-method',

  up: async () => {
    const result = await OAuthClientModel.updateMany(
      { tokenEndpointAuthMethod: { $exists: false } },
      { $set: { tokenEndpointAuthMethod: 'client_secret_post' } }
    );
    console.log(`${LOG} classified ${result.modifiedCount} legacy client(s) as client_secret_post`);
  },

  // No-op: the field cannot be un-set only on the rows this migration touched (an explicitly
  // classified confidential client is indistinguishable from a backfilled one), and a rollback of
  // the endpoint code stops reading the field entirely, so a populated value is harmless.
  down: async () => {},
};

export default migration;
