---
"@bike4mind/db-core": minor
---

softDeletePlugin now skips soft-deleted docs on update and replace queries (`findOneAndUpdate`, `updateOne`, `updateMany`, `findOneAndReplace`, `replaceOne`) unless the query sets `includeDeleted: true`, the filter names `deletedAt`, or the write is an update-verb upsert that leaves `deletedAt` untouched. A replace upsert (`replaceOne`/`findOneAndReplace` with `upsert: true`), or an update-verb upsert whose update `$set`s/`$unset`s/names `deletedAt`, onto a soft-deleted unique key now fails with E11000 instead of reviving the doc. `BaseRepository.update`/`updateMany` now silently skip a tombstone, and `updateGuarded` on a doc soft-deleted after the read resolves `null` instead of throwing `ConcurrencyConflictError`.
