/** Session (refresh) lifetime. Mirrors the current refresh-token TTL (30d). */
export const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rotation grace window. After a refresh rotates the token, the just-superseded hash stays valid
 * for this long, so a near-simultaneous second refresh (a second tab, or the WS auth-probe firing
 * alongside an axios 401) is served a fresh token instead of tripping reuse detection. Full
 * multi-tab convergence across refresh cycles is completed by cross-tab token propagation in the
 * cookie-storage work (epic #1187); this window covers the common concurrent-burst case.
 */
export const DEFAULT_GRACE_WINDOW_MS = 60 * 1000;
