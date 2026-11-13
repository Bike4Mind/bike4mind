# Private feedback notes

Internal note bodies are readable through the JWT-only feedback history endpoint with `users:moderate`. General audit entries contain report/note IDs, author, time and action metadata. Reporter responses do not include notes.

A note expires at its report text's existing deadline. If that text row is absent, the original report creation plus the existing 90-day retention is the conservative fallback. Reads hide expired bodies immediately; MongoDB's TTL index removes the rows asynchronously. Adding a note after the deadline is refused. Adding a note never renews report retention. Reports without a verifiable existing reporter account cannot acquire new note bodies.

Report deletion removes its notes in the same transaction. Self-serve account purge removes owner-associated notes, and hard account deletion removes them in the user-delete transaction. Note creation locks both the reporter and report, so concurrent purge/deletion cannot leave a new orphan.

## Rollout of existing inline notes

Migration `20260921240086` creates the note indexes and drains legacy inline bodies in bounded, repeat-safe transactions. Still-retainable bodies move under deterministic note IDs with their original time and existing expiry. Expired notes, deleted parents, and unavailable/unverifiable reporters lose their body while audit metadata remains. Conflicting destination records fail without overwriting either copy. The application audit model remains append-only; only this narrowly scoped retention helper uses raw conditional updates.

Deploy the new writer and history join, drain all old application writers, then run a post-cutover scrub for **every stage that served the old writer**:

```sh
pnpm exec sst shell --stage STAGE -- pnpm --filter @bike4mind/scripts feedback-notes:scrub --execute
pnpm exec sst shell --stage STAGE -- pnpm --filter @bike4mind/scripts feedback-notes:scrub
```

The second command is read-only and must report zero remaining inline notes. Repeat after any rollback to an older writer. No deployment or production data change is performed by tests or by adding this migration.

The existing daily telemetry cleanup also performs one bounded rescan (500 rows) in production/dev and self-host workers. Preview/staging do not have that hosted cron and require the explicit post-cutover command. This rescan catches rollout stragglers; it does not replace the post-cutover drain. General audit readers suppress legacy inline bodies throughout rollout.

Status changes remain idempotent: changing a closed report's resolution requires reopening and closing it again, preserving the existing transition/Undo audit contract.
