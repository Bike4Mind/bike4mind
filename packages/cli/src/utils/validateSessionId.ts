/**
 * Session and resume ids arrive from the environment (`B4M_SESSION_ID`,
 * `B4M_RESUME_ID`) and are used as filesystem path components by the session
 * store and the debug logger. Restrict them to a strict charset (which still
 * covers UUIDs) so a hostile launcher cannot traverse out of the base dir via
 * e.g. `B4M_SESSION_ID=../config`.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
