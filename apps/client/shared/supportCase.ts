/**
 * The support-case reference an admin names before reading customer content. Shared by the server
 * gate (server/utils/adminSupportAccess.ts) and the admin UI that collects it, so the UI never
 * sends a value the server will refuse.
 */
export const SUPPORT_CASE_MIN_LENGTH = 3;
export const SUPPORT_CASE_MAX_LENGTH = 200;

export const isValidSupportCase = (value: string): boolean => {
  const length = value.trim().length;
  return length >= SUPPORT_CASE_MIN_LENGTH && length <= SUPPORT_CASE_MAX_LENGTH;
};
