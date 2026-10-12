const FORBIDDEN_PATH_CHARS = new Set(['?', '#', '\\']);
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const MAX_WHITESPACE_OR_CONTROL_CODE = 0x20;
const DELETE_CODE = 0x7f;

// Whitespace and control characters count because the WHATWG URL parser silently strips tabs and
// newlines, so `.\t.` would otherwise collapse into a `..` segment after this check.
function hasForbiddenChar(path: string): boolean {
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code <= MAX_WHITESPACE_OR_CONTROL_CODE || code === DELETE_CODE || FORBIDDEN_PATH_CHARS.has(char)) return true;
  }
  return false;
}

/**
 * Throws unless `path` is a plain REST path whose target cannot be changed by its interpolated
 * values. Query strings go through the clients' `query` option, so a path never legitimately
 * carries `?` or `#`, and a `.`/`..` segment (literal or percent-encoded, which `new URL`
 * normalizes the same way) would resolve to a different endpoint than the one the caller built.
 */
export function assertSafeApiPath(path: string): void {
  if (hasForbiddenChar(path) || path.split('/').some(segment => DOT_SEGMENT.test(segment))) {
    throw new Error('Invalid API path: identifiers must not contain path or query syntax');
  }
}
