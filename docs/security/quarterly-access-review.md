# Quarterly access review

Once a quarter we review who holds privileged access and record the outcome. A review counts only when it leaves a record: the enumerated access, a keep or revoke decision for each grant with who decided it, what was revoked, and the counts before and after.

This page covers the app database part of the review. Other systems in scope (the source control organisation, cloud accounts) are enumerated by their owners and filed with the same record.

## Cadence

The review runs in the first week of January, April, July and October. The daily `secretRotationNotifier` cron (09:00 UTC) posts the reminder to the LiveOps Slack channel on the first Monday of each of those months, in production only. The message names the quarter, lists the current counts and links back here. The same run logs the counts as one JSON line (`"report":"access-review"`) in the function's CloudWatch logs, so the quarter's starting point is on record even before anyone acts on it.

The reminder needs the LiveOps Slack webhook admin setting. Without it the cron logs that the webhook is not configured and posts nothing. If the counts cannot be read or Slack does not accept the reminder, the cron logs the error and still posts any secrets due for rotation; start the review from the report below instead.

## What the report covers

`report:access-review` reads the app database without writing to it. It never reads API key secrets, hashes, digests or prefixes.

- **Admin accounts:** every user with the full admin flag or any delegated admin permission, with account status (active, banned, deleted), last activity, and per-account counts of active sign-in sessions, trusted devices, passkeys, OAuth refresh tokens, paired bridge devices and active API keys.
- **Privileged API keys:** active, unexpired keys owned by an admin account or carrying the `admin:*` scope, with owner, scopes, created, last used and expiry. Pass `--all-keys` to list every active key.
- **Support access and impersonation:** live support access grants and live impersonation sessions, with the session ID, the admin and the target account.
- **Counts:** admin accounts, active API keys (with admin-scoped, admin-owned, no-expiry and unused-for-90-days subsets), sign-in sessions, impersonation sessions, support access grants, trusted devices, passkeys, OAuth app grants, OAuth refresh tokens and paired bridge devices, across all users.

## Running the review

Run from the repo root with production credentials. The output names real accounts, so write it outside the repository and never commit it; the script writes its files readable by the owner only, including when replacing existing output files.

1. **Enumerate.** Take the before snapshot:

   ```bash
   mkdir -p ~/access-review
   npx sst shell --stage production pnpm --filter @bike4mind/scripts report:access-review \
     --out ~/access-review/before.md --json ~/access-review/before.json
   ```

2. **Decide.** In `before.md`, fill in Reviewer, then for every row set Decision to `keep` or `revoke` and Decided by to the person who made the call. Anything nobody can vouch for is a revoke.

3. **Revoke.** Act on each revoke from the user's page in the admin Users list: remove the admin flag or delegated permissions, revoke the API keys, and sign out the sessions. Support access and impersonation end with their session, so sign that session out from the target user's sessions list. Log each one in the Revocations table at the bottom of the report.

4. **Record the after counts.** Re-run against the before snapshot:

   ```bash
   npx sst shell --stage production pnpm --filter @bike4mind/scripts report:access-review \
     --baseline ~/access-review/before.json --out ~/access-review/after.md --json ~/access-review/after.json
   ```

   The counts table in `after.md` shows before, after and the change for each line. Check that every revoke shows up as a drop.

5. **File the record.** Attach the completed `before.md`, `after.md` and both JSON snapshots to the quarter's review ticket on the private tracker, set Review completed, and close it. Keep `after.json` as the next quarter's comparison point.

The script works against any stage: swap `--stage`. `--help` lists every option.
