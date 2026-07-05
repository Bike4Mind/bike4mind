// Key format: b4m_live_[32 hex chars] = 41 chars total.
// 16-char prefix = 7 hex chars after "b4m_live_" -> 268M distinct values.
// Must stay in sync across create / rotate / validate.
export const KEY_PREFIX_LENGTH = 16;

// Prefix length used by create/rotate/validate before Jun 2026. Keys minted
// back then are stored with 12-char prefixes, and the full prefix cannot be
// re-derived from the bcrypt keyHash - validate must fall back to this length
// or every pre-existing key fails lookup (401 "Invalid API key").
export const LEGACY_KEY_PREFIX_LENGTH = 12;
