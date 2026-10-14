// A 10s 4k clip is well under this; anything larger is a provider anomaly, not a video we keep.
export const MAX_VIDEO_OUTPUT_BYTES = 256 * 1024 * 1024;
// Inline provider output is persisted on the job document between the poll and store steps.
export const MAX_INLINE_PROVIDER_OUTPUT_BYTES = 1024 * 1024;
