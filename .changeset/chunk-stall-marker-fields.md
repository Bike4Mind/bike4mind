---
"@bike4mind/common": major
"@bike4mind/utils": major
"@bike4mind/services": major
---

Chunk-stall markers move off `FabFile.notes` into their own fields. `findDataLakeHealthMembers`,
`findLakeConvergenceMembers` and `IndexStateFile` rename the required `notes: string | null` to
`chunkStallReason: ChunkStallReason | null`; the deprecated note-string aliases cannot cover that.
