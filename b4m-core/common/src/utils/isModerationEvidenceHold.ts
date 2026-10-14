// Written by moderateUploadedFile when the bytes cannot be scanned at all (e.g. HEIC, SVG).
export const UNSUPPORTED_FORMAT_BLOCK_REASON = 'unsupported_format';

/**
 * Whether a FabFile's stored bytes must survive an owner-driven delete: a moderation block that
 * may be section 2258A evidence pending triage. An 'unsupported_format' block (bytes that could
 * not be scanned at all) never raises an incident, so it is not held.
 *
 * Used by fabFileService/deleteStoredObjects.ts, which the single, bulk and delete-all file deletes
 * go through. Only the bytes follow this rule: the FabFile hard-delete row guards still hold every
 * 'blocked' row, including unsupported_format.
 */
export function isModerationEvidenceHold(f: {
  moderationStatus?: string | null;
  blockReason?: string | null;
}): boolean {
  return f.moderationStatus === 'blocked' && f.blockReason !== UNSUPPORTED_FORMAT_BLOCK_REASON;
}
