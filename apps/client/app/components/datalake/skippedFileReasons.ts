import type { LakeSkippedFileReason } from '@bike4mind/common';

// Exhaustive on purpose: adding a reason to LAKE_SKIPPED_FILE_REASONS fails typecheck until it has copy.
export const SKIPPED_FILE_REASON_LABELS: Record<LakeSkippedFileReason, string> = {
  oversized: 'Larger than the per-file size limit',
  exceeds_max_file_size: 'Larger than the maximum file size set for this workspace',
  oversized_after_fetch: 'Turned out larger than the per-file size limit when downloaded',
  unsupported: 'This file type cannot be imported',
  export_too_large: 'Too large for Google Drive to export',
  error: 'Could not be downloaded; it will be retried on a later sync',
  storage_limit: 'Your storage is full; it will be retried after you free up space',
  binary: 'Not a text file',
  invalid_utf8: 'Not valid UTF-8 text',
};

export const skippedFilesChipLabel = (total: number): string =>
  total === 1 ? '1 file not ingested' : `${total} files not ingested`;
