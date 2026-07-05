/**
 * PRIVACY: Telemetry queries MUST use this projection to prevent re-identification.
 * Quest documents contain session.userId alongside contextTelemetry - projecting
 * only telemetry fields maintains pseudonymization at the API layer.
 */
export const TELEMETRY_SAFE_PROJECTION = 'promptMeta.contextTelemetry timestamp';

/**
 * Stricter projection that also excludes _id (a linkable identifier).
 * Used for DSAR exports and bulk listings where _id is not needed and
 * would weaken pseudonymization by allowing cross-reference to the full quest.
 */
export const TELEMETRY_EXPORT_PROJECTION = '-_id promptMeta.contextTelemetry timestamp';
