---
"@bike4mind/db-core": minor
---

softDeletePlugin now skips soft-deleted docs on update and replace queries (`findOneAndUpdate`, `updateOne`, `updateMany`, `findOneAndReplace`, `replaceOne`) unless the query sets `includeDeleted: true`, the filter names `deletedAt`, or the write is an upsert. `BaseRepository.update`/`updateMany` now silently skip a tombstone, and `updateGuarded` on a doc soft-deleted after the read resolves `null` instead of throwing `ConcurrencyConflictError`.
