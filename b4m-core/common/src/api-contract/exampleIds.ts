/**
 * Canned ObjectId placeholders for contract examples and code samples. They are fixed doc
 * values, never real document ids: contracts import them instead of inlining hex literals, so
 * this file (plus the generated openapi.json) is the only place the account-tied-id guard
 * allows them - see scripts/account-ids-allowlist.txt. Changing a value changes the published spec.
 */
export const EXAMPLE_RESOURCE_ID = '664f1c2b9a1e4d0012ab34cd';
export const EXAMPLE_SESSION_ID = '664f1c2b9a1e4d0012ab34aa';
export const EXAMPLE_FILE_ID = '664f1c2b9a1e4d0012ab34bb';
// The canonical MongoDB-docs example ObjectId.
export const EXAMPLE_USER_ID = '507f1f77bcf86cd799439011';
