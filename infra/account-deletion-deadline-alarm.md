# Account deletion deadline alarm

Alarm `<app>-<stage>-account-deletion-deadline` (`infra/alarms.ts`, `accountDeletionDeadline`) pages
the DLQ alarm topic when an account deletion request is 25 days old or more and still open. Erasure is
due within one month, so this leaves about five days to act.

The daily sweep (`apps/workers/src/cron/accountDeletionSweep.ts`) counts open requests whose
`deletion.requestedAt` is at least 25 days old and emits it as `OverdueDeletionRequests` in
`Lumina5/AccountDeletion`, dimension `Stage` only. It emits before it purges, so a run that later fails
has still reported. An open request is a user row that still has `deletion` set; a completed one is gone
and a cancelled one has `deletion: null`.

**The alarm also fires when the metric is missing.** The window is two days, the expression is
`FILL(m, 1)` and missing data counts as breaching, so a sweep that stopped running or emitting pages
instead of silencing the alarm. Step 1 tells the two cases apart.

**Expect one page on the first deploy.** A new alarm has no datapoint until the first 05:00 UTC sweep
emits (0 on a healthy day), so it reads as breaching until then. If that page arrives right after the
alarm is first created, wait for the next sweep run before acting.

**Recovery is slow by design.** The period is two days and the statistic is `Maximum`, so after the last
non-zero datapoint the alarm stays in ALARM for up to about 48 hours, and re-running the sweep does not
shorten that. Judge the fix by the sweep's own count reaching 0, not by the alarm state.

## When it fires

1. Did the sweep run and emit? Check the `accountDeletionSweep` Lambda logs and its dead-letter queue
   (`accountDeletionSweepDlq`, alarmed in `infra/dlqAlarms.ts`). Look for an `OverdueDeletionRequests`
   datapoint in the last two days. No datapoint means the sweep is down: fix that first (schedule,
   deploy, `MONGODB_URI`), then re-run it.
2. List the overdue users in the database: `deletion.requestedAt` older than 25 days with `deletion`
   set. Newest request first is not needed; the oldest is the one closest to the deadline.
3. For each, find why it was not purged:
   - a live data export or purge lease (`accountDataExportLease`, `deletion.purgeLeaseExpiresAt`): `busy`
   - the user still owns an organization with other members: the sweep refuses until ownership moves
   - a thrown error: the sweep log line `Failed to delete user`
   - `deletion.scheduledFor` still in the future: a request that support logged late keeps its original
     `requestedAt` but is scheduled 14 days from when it was logged, so it counts as overdue while the
     sweep correctly reports it not due. Bring `scheduledFor` forward, or cancel the deletion and erase
     the account by hand (step 4)
4. Fix the cause and re-run the sweep, or complete the request by hand through the admin erasure path
   before day 30. The admin erasure path refuses an account with any pending deletion not started by an
   admin (self-service or support-logged), so cancel that deletion first. Once the row is gone the next run emits 0, and the alarm clears within
   about two days (see above).

## Confirmation email retries

The post-deletion confirmation is stored in the `AccountDeletionNotice` collection in the same
transaction as the delete, sent once, and retried by each daily sweep. Five recorded delivery failures
exhaust the notice. The address is removed once a send succeeds or after the last recorded failure
(a 30-day TTL is the backstop). The
sweep result carries `notices: { sent, failed, abandoned }`; an abandoned notice is logged at error.
Nothing logs the address or the user id.

Both the immediate post-commit send and each sweep first acquire the same atomic notice claim. A
claim lasts for the existing one-hour retry window; only its token may remove or reschedule the row.
Each drain attempts a given notice at most once, even if its send outlives that window.
Legacy rows without claim fields remain eligible, and a crashed sender can be retried after expiry.
The first stored recipient and original 30-day TTL are unchanged. A crash after recording the final
failure is cleaned up without sending a sixth email.

This prevents ordinary overlapping senders while a claim is valid. External acceptance followed by a
crash, cleanup failure, or a send outliving the claim can still result in a later duplicate; publication
is not proof of physical email delivery.
