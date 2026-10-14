/**
 * Whether a FabFile's stored bytes must survive an owner-driven delete: a moderation block that
 * may be section 2258A evidence pending triage. An 'unsupported_format' block (bytes that could
 * not be scanned at all) never raises an incident, so it is not held.
 *
 * Used by fabFileService/deleteStoredObjects.ts, which every owner delete path goes through.
 */
export function isModerationEvidenceHold(f: {
  moderationStatus?: string | null;
  blockReason?: string | null;
}): boolean {
  return f.moderationStatus === 'blocked' && f.blockReason !== 'unsupported_format';
}
