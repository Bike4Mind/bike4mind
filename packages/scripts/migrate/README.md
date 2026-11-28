# Database migrations

`MigrationManager` (`migrationManager.ts`) runs every registered migration whose id is not yet
recorded in the `migrations` collection. It runs on every deploy (the `DatabaseMigrator` Lambda in
`infra/database.ts`, through `apps/workers/src/database/manageDatabase.ts`) and from the CLI
(`pnpm migrate up|down|list|generate`).

## Adding a migration

```bash
pnpm migrate generate "add fancy new field"
```

The generator stamps the id from the current UTC time and registers the file in
`migrations/core.generated.ts`. Never hand-pick or reuse an id. Fill in `up()`, `down()` and
`rerunSafe`.

## Every migration must be safe to run again

The runner records a migration only after its `up()` returns. If `up()` throws, or the Lambda times
out or crashes partway, nothing is recorded and the next deploy runs that `up()` again from the
start, on top of whatever the first attempt already wrote.

So every `up()` must reach the same end state whether it starts from scratch or from a partial
earlier attempt. Common ways to get there:

- Select only the documents that still need the change (`{ newField: { $exists: false } }`) rather
  than every document.
- Use upserts keyed on a natural key instead of plain inserts.
- Build indexes with `Model.createIndexes()` / `createIndex`, which are no-ops when the index
  exists; tolerate `IndexNotFound` (code 27) when dropping one.
- Make transformations idempotent (setting a value, not incrementing it).
- For long backfills, return `{ incomplete: true, reason }` when out of time; the runner leaves the
  migration pending and the next run continues where the selection left off.

Write why in the `rerunSafe` field, in one sentence. `scripts/check-migration-ids.mjs` (the
"Check added core migration ids are generated" CI step) fails a pull request that adds a core
migration whose `rerunSafe` is missing, empty, or still the generator's `TODO` placeholder. It
checks that the note exists, not that it is true: reviewers own that. Overlay migrations live in
their own repositories and are not checked by it, but the same rule applies.

## One runner at a time

`up()` and `down()` run only while holding the migration lease: a single document (`_id:
'migrator'`) in the `migrationlocks` collection with an owner id and an expiry
(`migrationLock.ts`).

- The lease is taken with one atomic upsert that matches only an expired lease. A second run that
  starts while a live lease exists fails with an error without running anything. The holder may be
  a dead run whose lease has not expired yet, so the failing run turns the deploy red instead of
  letting it ship before its migrations ran; re-run the deploy once the lease is free.
- The holder renews the lease every minute for another 5 minutes, and releases it when it finishes
  (also when it fails).
- A run that dies without releasing (a Lambda timeout, a crash) leaves a lease that expires within
  5 minutes, after which the next run takes it over. The migrator Lambda times out at 15 minutes,
  so a dead run can hold up migrations for at most a third of one Lambda run.
- A run that finds its lease lost (taken over, or not renewed before it expired) stops before the
  next migration with an error.

`list`, `seed` and `cleanup` do not take the lease. `cleanup`, `deleteDatabase` and the preview
database drop (`apps/workers/src/database/dropPreviewDatabase.ts`) drop `migrationlocks` with every
other collection.

## Duplicate migration records

`migrations.id` has a unique index, so the database rejects a second record for the same migration.
The index is built by the `ensure migration id unique index` migration. Before building it, that
migration looks for ids already recorded more than once; if it finds any it changes nothing and
fails, naming each id, its count and its names. It is fail-closed, so the other pending migrations
still run and the deploy stays red until the duplicates are resolved.

Duplicates are never deleted automatically. To resolve them, connected to that stage's database:

1. List them:

   ```js
   db.migrations.aggregate([
     { $group: { _id: '$id', count: { $sum: 1 }, names: { $addToSet: '$name' }, docs: { $push: { _id: '$_id', migratedAt: '$migratedAt' } } } },
     { $match: { count: { $gt: 1 } } },
   ]);
   ```

2. For each id whose records all carry the **same name**, the migration was recorded twice (it ran
   twice, or two runs raced before the lease existed). The records are interchangeable: keep the
   one with the earliest `migratedAt` and delete the others by `_id`.
3. If one id carries **different names**, two different migrations share an id (for example a core
   and an overlay migration). Do not delete anything: find out which migration each record belongs
   to and give one of them a new id in its source repository first.

Then redeploy; the migration builds the index on its next run.
