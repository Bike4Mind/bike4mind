import { OAuthClientModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[backfill-oauthclient-token-endpoint-auth-method]';

// Operator opt-in gate. The write is destructive for one class of legacy client (see below), so it
// only runs once an operator has audited the collection and set this in the stage's environment.
const CONFIRM_ENV = 'OAUTH_BACKFILL_CONFIRMED';

/**
 * Backfill `tokenEndpointAuthMethod: 'client_secret_post'` for every OAuth client that predates the
 * field, so existing confidential integrations keep working once the hardened token endpoint ships.
 *
 * The endpoint now keys the confidential-vs-public decision on this field, not on whether a secret
 * was sent: a client without it is treated as public and rejected unless it presents PKCE.
 *
 * WHY THIS IS GATED: minting a secret at registration is not the same as presenting one at the token
 * endpoint. A legacy client that was registered with a secret but authenticates PKCE-only would be
 * wrongly stamped confidential here and then start failing its code exchange with 401. That is only
 * answerable against the live `oauthclients` collection, so this migration will not write on its own.
 *
 * OPERATOR RUNBOOK:
 *   1. Deploy. With un-classified rows present and `${CONFIRM_ENV}` unset, this migration reports the
 *      count it *would* stamp and then throws, so it stays pending (the deploy fails loudly rather
 *      than silently reclassifying). A stage with no un-classified rows (fresh install, CI) is a
 *      no-op and does not block.
 *   2. Audit `oauthclients` and set `tokenEndpointAuthMethod: 'none'` on any PKCE-only client. The
 *      `{ $exists: false }` filter then leaves those rows untouched. Classify each client from how it
 *      actually authenticates today (from the integration/registration owner), NOT from any data
 *      field. In particular the removed `pkceRequired` field survives on legacy documents as `true`
 *      on every row, is read by no code path, and is NOT the audit signal - trusting it would stamp
 *      every client `'none'` and break all confidential integrations. No migration unsets it.
 *   3. Set `${CONFIRM_ENV}=1` on the stage and redeploy. The backfill stamps the remaining
 *      un-classified rows `client_secret_post`. Idempotent - already-classified rows are skipped and
 *      a re-run finds nothing.
 *
 * The gate is a throw (not a silent no-op) on purpose: `MigrationManager.up()` records any migration
 * whose `up()` returns as applied, so a log-only return would mark this done and the confirmed run
 * could never happen. Throwing keeps it in the pending set until the operator confirms.
 */
const migration: MigrationFile = {
  id: 20260912000000,
  name: 'backfill-oauthclient-token-endpoint-auth-method',

  up: async () => {
    const pending = await OAuthClientModel.countDocuments({ tokenEndpointAuthMethod: { $exists: false } });

    if (pending === 0) {
      console.log(`${LOG} no un-classified legacy clients; nothing to backfill`);
      return;
    }

    if (process.env[CONFIRM_ENV] !== '1') {
      console.log(`${LOG} ${pending} un-classified legacy client(s) would be stamped client_secret_post; not writing`);
      throw new Error(
        `${LOG} refusing to run: audit oauthclients and set tokenEndpointAuthMethod:'none' on any PKCE-only ` +
          `client, then set ${CONFIRM_ENV}=1 on this stage to confirm the backfill`
      );
    }

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
