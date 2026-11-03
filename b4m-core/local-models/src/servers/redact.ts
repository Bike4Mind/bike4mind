/** RFC 7235 auth-scheme (a token), then whitespace, then the credential itself. */
const AUTH_SCHEME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s+(\S.*)$/;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g;
/** Shorter values are matched only as a whole word, so a one-letter value does not mangle every reply. */
const SHORT = 8;
/** `\uXXXX` is the longest way a JSON encoder writes one character. */
const MAX_CHAR_FORM = 6;
const JSON_SHORT_ESCAPES = new Map([
  [0x08, 'b'],
  [0x09, 't'],
  [0x0a, 'n'],
  [0x0c, 'f'],
  [0x0d, 'r'],
]);

export interface CredentialRedactor {
  redact(text: string): string;
  /** The longest text one match can span. */
  longest: number;
}

/**
 * Replaces every credential value a server reply might quote back: the header value, the part after an
 * auth scheme, and for Basic the decoded `user:pass` and the password. Each character may also appear
 * backslash-escaped or as `\uXXXX`, as JSON encoders write them (Go escapes `&<>`, Python non-ASCII).
 */
export function credentialRedactor(credentials: Record<string, string> | null): CredentialRedactor | null {
  const secrets = new Set<string>();
  for (const value of Object.values(credentials ?? {})) {
    secrets.add(value);
    const token = AUTH_SCHEME.exec(value)?.[1];
    if (!token) continue;
    secrets.add(token);
    if (/^basic\s/i.test(value)) {
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0) secrets.add(decoded).add(decoded.slice(colon + 1));
    }
  }
  secrets.delete('');
  if (secrets.size === 0) return null;
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(ordered.map(secretPattern).join('|'), 'g');
  return {
    redact: text => text.replace(pattern, '[redacted]'),
    longest: ordered[0].length * MAX_CHAR_FORM,
  };
}

function secretPattern(secret: string): string {
  let body = '';
  for (let index = 0; index < secret.length; index++) {
    const code = secret.charCodeAt(index);
    const literal = String.fromCharCode(code).replace(REGEX_SPECIAL, '\\$&');
    const hex = code
      .toString(16)
      .padStart(4, '0')
      .replace(/[a-f]/g, digit => `[${digit}${digit.toUpperCase()}]`);
    const shortEscape = JSON_SHORT_ESCAPES.get(code);
    body += `(?:${literal}|\\\\${literal}|\\\\u${hex}${shortEscape ? `|\\\\${shortEscape}` : ''})`;
  }
  return secret.length < SHORT ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body;
}
