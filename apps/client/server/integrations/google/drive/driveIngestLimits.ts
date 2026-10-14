// Ingest limits shared by the Drive lake worker (apps/workers driveLakeIngest) and the wizard's
// pre-flight folder estimate, so the estimate's counts cannot drift from what the worker enforces.

// Per-file hard cap. Files are fetched and uploaded ONE at a time (only one buffer is ever live),
// so this bounds peak memory well under the ingest queue Lambda's 1024 MB default. An oversized
// file is skipped-and-counted (before the download when the size is known up front), so the failure
// mode is a skipped file rather than an OOM that kills the whole run mid-loop. A streaming path for
// genuinely large files is the "very large folders" follow-up.
export const MAX_INGEST_FILE_BYTES = 50 * 1024 * 1024;

// Cap on the un-sliceable part of a sync: the folder walk and the diff against this connection's
// stored set, both of which hold a full listing in memory in EVERY slice and must complete inside one
// invocation before any file is touched - a folder-wide constant regardless of how small any one
// slice's delta is. This is NO LONGER a throughput bound on the ingestable count - the worker's deadline
// guard yields to a continuation slice rather than timing out mid-loop, so that count is bounded by
// MAX_INGEST_SLICES x a slice's throughput (tens of thousands of files) and not by one invocation.
// Checked against walked.length and existingDocs.length (see the enforcement in driveLakeIngest), not the delta
// between them - gating on the delta would let a folder with a huge stable listing and a tiny delta
// pay the walk+diff cost on every slice with the cap never tripping. Enforced up front, before any
// membership write, so an over-cap folder is refused with nothing changed. Beyond it the folder should
// be split into subfolders connected separately.
//
// Memory headroom at this value is not yet independently measured. findByDriveConnectionIdInDataLake
// has no projection or limit, so existingDocs at the cap hydrates up to 20000 full FabFile documents
// (previously 1500, ~13x) on the ingest queue Lambda's 1024 MB default (infra/queues.ts sets no
// override for it, unlike most of its siblings there). If that turns out to be tight, either project
// the query down to the fields the diff actually reads (driveFileId, md5Checksum, modifiedTime) or set
// an explicit memory override on the Lambda - both are cheaper than lowering this constant.
//
// Also, indirectly, a bound on the size of ONE batch document: every candidate a chain ingests gets a
// manifest entry in `files[]` on this same DataLakeBatch doc, and both claimFileStatus's positional
// update and every finalize check read the whole document. Raising this constant further raises that
// document's worst-case size (and, with failedFileNames also accumulating, moves it closer to the 16MB
// BSON ceiling) as well as the walk+diff cost the comment above is about.
export const MAX_INGEST_CANDIDATES = 20000;

/**
 * The size-based skip the worker applies before fetching a file, shared with the estimate so the two
 * cannot classify differently. `undefined` size (Editors files) is never skipped here.
 */
export function driveIngestSkipReason(
  size: number | undefined,
  maxFileSize: number
): 'oversized' | 'exceeds_max_file_size' | null {
  if (size == null) return null;
  if (size > MAX_INGEST_FILE_BYTES) return 'oversized';
  if (size >= maxFileSize) return 'exceeds_max_file_size';
  return null;
}
