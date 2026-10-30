# Credential storage and logging

Submitted credential strings are always plaintext inputs to encryption, even when they resemble
stored ciphertext. Preserve an unchanged secret by retaining a value from the owned database record;
do not accept client-supplied ciphertext as proof of prior encryption.

New provider keys and MCP environment values use versioned AES-GCM ciphertext. Associated data binds
provider keys to their user, record ID and field, and MCP values to their user, server ID and variable
name. Keep these identifiers when rotating keys. Legacy plaintext and unbound ciphertext remain
readable during the backfill. Changing a server's display name does not change its encryption context.

The credential backfill is an explicit operator command, `pnpm --filter @bike4mind/scripts migrate:protect-credentials --maintenance-window`.
It is deliberately excluded from the automatic pre-deployment migrations: old readers cannot
consume the new ciphertext formats. It encrypts legacy Slack app
credentials, hashes legacy security answers, binds existing provider/MCP credentials, clears expired
rotation secrets and wraps raw memory data keys. Writes compare the values they read so a concurrent
credential update is not overwritten. If a key is unavailable, the migration fails and remains pending.

Use a maintenance window for this upgrade. Stop incoming requests and pause/drain queue consumers,
scheduled jobs and other credential/memory writers. Provision the keys, deploy the new web and worker
code, and wait for old instances and invocations to terminate. Run the backfill in the stage's
configured operator environment, run it a second time to confirm convergence, then resume traffic and
workers. Do not run the backfill during a rolling deployment or while legacy writers remain active.
The command is repeatable and is not marked permanently complete by the migration manager.

Before deployment, provision a persistent `MEMORY_KEY_SECRET` alongside `SECRET_ENCRYPTION_KEY`.
Generate independent random values; for example, `openssl rand -hex 32`. Cloud deployments validate the
secret before creating resources. Self-host installations provide it through their runtime environment.
Back it up securely and keep it stable across redeployments: replacing it makes wrapped memory keys
unreadable. Deployed memory providers refuse to operate without it. Provisioning the secret alone does
not protect existing raw data keys; run the backfill too.

The cloud deploy check applies to every stage, including PR previews and personal stages. Before this
change reaches `main`, set an account-wide default in each AWS account those stages deploy to
(`sst secret set MEMORY_KEY_SECRET <hex> --fallback`), or every preview and personal-stage deploy is
refused. The same stability rule applies: the fallback must not be replaced once stages have used it.

The token/API-key maintenance commands understand both ciphertext versions. Their rotation operations
must receive the owning context; copying a bound blob to another record or variable is rejected.
Keep the previous encryption key available until the backfill/rotation completes. Do not use plaintext
rollback commands during ordinary key rotation.

Security-question profile responses contain question text and blank answers. A blank answer preserves
the existing answer for the same question. Supply a new answer when adding or renaming a question.
Stored answers and their hashes are never returned to the profile form.

Log identifiers, counts, lengths and status codes. Pass errors through the shared logger or
`redactErrorForLog`; never interpolate request bodies, prompt text, conversations, tool arguments or
provider responses into log strings. Structured-log redaction cannot recover the meaning of an
arbitrary string after it has been formatted. Security-email Slack mirrors omit subject/body content
and use only the dedicated email audit webhook.
