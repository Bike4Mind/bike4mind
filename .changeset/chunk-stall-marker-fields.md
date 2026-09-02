---
"@bike4mind/common": major
"@bike4mind/utils": major
"@bike4mind/services": major
---

Chunk-stall markers move off `FabFile.notes` into their own fields. `findDataLakeHealthMembers` and
`findLakeConvergenceMembers` rename a required `notes: string | null` to
`chunkStallReason: ChunkStallReason | null`; the deprecated note-string aliases cannot cover that.
`IndexStateFile` renames the same field, optional on both sides - a caller still passing the old
shape type-checks but reads `undefined` and silently never trips `isChunkStalled`, which is why the
services bump is a major too.
