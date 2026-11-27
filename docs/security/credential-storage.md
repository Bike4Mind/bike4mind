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
credentials, hashes legacy security answers, encrypts legacy TOTP seeds, binds existing provider/MCP credentials, clears expired
rotation secrets and wraps raw memory data keys. Writes compare the values they read so a concurrent
credential update is not overwritten. If a key is unavailable, the migration fails and remains pending.

Use a maintenance window for this upgrade. Stop incoming requests and pause/drain queue consumers,
scheduled jobs and other credential/memory writers. Provision the keys, deploy the new web and worker
code, and wait for old instances and invocations to terminate. Run the backfill in the stage's
configured operator environment, run it a second time to confirm convergence, then resume traffic and
workers. Do not run the backfill during a rolling deployment or while legacy writers remain active.
The command is repeatable and is not marked permanently complete by the migration manager.

To see what is left, run the read-only census, `pnpm --filter @bike4mind/scripts audit:credential-census`, before
and after the backfills and after restoring a backup. It prints the database it read and, per credential field, how
many stored values are still plaintext, unhashed or not yet context-bound. Each pending row names the backfill that
converts it, or `no backfill`. Exit 0 means nothing is pending. Exit 1 means values remain; a `no backfill` row needs
a manual fix, so exit 1 does not always clear after the backfills. Exit 2 means an error, or that every field was
empty (wrong or empty database). The census writes nothing and prints no values or document ids.

The `identityproviders` row is covered by a deploy migration that `migrate up` skips once it is recorded as
applied. To re-apply it, delete its record (id `20260904000000`) from the `migrations` collection, then run
`migrate up`.

Before deployment, provision a persistent `MEMORY_KEY_SECRET` alongside `SECRET_ENCRYPTION_KEY`.
Generate independent random values; for example, `openssl rand -hex 32`. Cloud deployments validate the
secret before creating resources. Self-host installations provide it through their runtime environment.
Back it up securely. Never replace it in place: wrapped memory keys become unreadable. Rotate it only by
the procedure below. Deployed memory providers refuse to operate without it. Provisioning the secret alone does
not protect existing raw data keys; run the backfill too.

### Rotating MEMORY_KEY_SECRET

Readers open a memory key wrapped under either `MEMORY_KEY_SECRET` or `MEMORY_KEY_SECRET_PREVIOUS`; new
keys are always wrapped under the current one. Each step is a full deploy of every service (cloud) or a
restart of the stack (self-host, with the environment variables of the same names). Do not skip or
reorder: during a rolling deploy old and new instances run together, so a plain swap would leave
instances that cannot open each other's keys.

1. Deploy code that reads `MEMORY_KEY_SECRET_PREVIOUS`, with it still unset (`not-configured`).
2. Set `MEMORY_KEY_SECRET_PREVIOUS` to the new value and deploy. Every instance can now open keys
   wrapped under either the old or the new value.
3. Set `MEMORY_KEY_SECRET` to the new value and `MEMORY_KEY_SECRET_PREVIOUS` to the old value, and deploy.
4. Run `migrate:rewrap-memory-keys --dry-run`, then `migrate:rewrap-memory-keys`, then
   `migrate:rewrap-memory-keys --verify` (`pnpm --filter @bike4mind/scripts`, under `sst shell` for cloud).
   Self-host: from the repo checkout, export `MEMORY_KEY_SECRET`, `MEMORY_KEY_SECRET_PREVIOUS` and a
   host-reachable `MONGODB_URI` (Compose: the localhost URI; Kubernetes: a port-forward), exactly as the
   credential backfill in `SELF_HOST.md` does, then run the same three commands with the `tsx --import`
   form shown there. The command prints counts only and is safe to repeat; a second run rewraps 0. It stops
   with exit 2 if any key is stored unwrapped (run `migrate:protect-credentials --maintenance-window` first).
   The initial raw-key census stops before writes. If a raw key appears later, counts include any
   completed rewraps; those are safe to keep when repeating the procedure.
   `--dry-run` exits 1 while keys still need rewrapping. The command resolves memory-key secrets in
   the same environment-first order as the runtime, then falls back to SST resources, and exits 2 when
   an exported secret differs from the linked SST resource (unset it, or run outside `sst shell`).
   `--verify` also decrypts the newest stored fact from the current key incarnation per principal.
   After an erase and remint, facts created at or before the last erase cannot verify the new key;
   a principal with no newer encrypted fact is counted as `principals-without-facts`.
5. Once `--verify` exits 0, clear `MEMORY_KEY_SECRET_PREVIOUS` (`not-configured`) and deploy, then run
   `--verify` again.

Rollback: before step 5, put the old value back in `MEMORY_KEY_SECRET` and the new one in
`MEMORY_KEY_SECRET_PREVIOUS`; both are still readable. After step 4 every key is wrapped under the new
value, so a rollback is the same procedure in reverse and ends with a rewrap and `--verify` before
`MEMORY_KEY_SECRET_PREVIOUS` is cleared. After step 5 the old value is no longer needed
by the live data, but a database backup taken before the rewrap still holds keys wrapped under it:
keep the old value until those backups age out of retention.

The production procedure above does not rewrap preview and personal stages that read the account-wide fallback. Set the old value
with `sst secret set MEMORY_KEY_SECRET_PREVIOUS <old> --fallback` and the new one with
`sst secret set MEMORY_KEY_SECRET <new> --fallback`. Previews accept the single-step swap, without the
step 2 deploy. The fallback previous key applies to every stage in that account that has no value of its
own.

The production procedure does not rewrap those stages, so memory keys a stage minted before its first deploy
after the swap stay under the old value and are readable only through the fallback previous key. Before clearing it
(`sst secret set MEMORY_KEY_SECRET_PREVIOUS not-configured --fallback`), redeploy each stage whose memory
should survive so it runs with the swapped values, then run `migrate:rewrap-memory-keys --dry-run`, the
default run and `--verify` under `sst shell --stage <stage>`. Skipping the redeploy leaves the running stage
unable to open rewrapped keys. Otherwise accept that those keys, and every fact stored under them (including facts appended after the swap),
become unreadable on every stage that still reads the fallback, taking effect at that stage's next deploy. Long-lived personal stages are the ones most likely to need the rewrap.

The cloud deploy check applies to every stage, including PR previews and personal stages. Before this
change reaches `main`, set an account-wide default in each AWS account those stages deploy to
(`sst secret set MEMORY_KEY_SECRET <hex> --fallback`), or every preview and personal-stage deploy is
refused. Do not replace the fallback once stages have used it, except as described above.

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
