---
"@bike4mind/db-core": minor
---

softDeletePlugin now skips soft-deleted docs on update and replace queries (`findOneAndUpdate`, `updateOne`, `updateMany`, `findOneAndReplace`, `replaceOne`) unless the query sets `includeDeleted: true`, the filter names `deletedAt`, or the write is an update-verb upsert. A replace upsert (`replaceOne`/`findOneAndReplace` with `upsert: true`) onto a soft-deleted unique key now fails with E11000 instead of reviving the doc. `BaseRepository.update`/`updateMany` now silently skip a tombstone, and `updateGuarded` on a doc soft-deleted after the read resolves `null` instead of throwing `ConcurrencyConflictError`.
