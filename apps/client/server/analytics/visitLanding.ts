/**
 * Where a visit came from and the page it landed on, as the visit beacon reports them.
 *
 * The beacon is a fetch from the app's own page, so its Referer header names that page, never
 * the site the visitor came from: read from the header, every visit's source was the app itself.
 * The browser therefore sends `document.referrer` and the landing path in the beacon's body,
 * and only with consent (see visitBeacon.ts). Anyone can post to the beacon, so both values are
 * checked here and reduced to the least that answers the question: the referrer to its origin,
 * the landing path to its path, with anything shaped like a secret replaced.
 */

/** The longest landing path kept, in characters. visitBeacon.ts cuts to the same cap before sending. */
export const MAX_LANDING_PATH = 200;

/** What a secret-shaped path segment is sent as. */
export const PATH_SECRET_PLACEHOLDER = ':token';

/**
 * One run of token characters (see PATH_SEPARATORS) shaped like a secret: a UUID; 16 or more hex
 * digits (a reset token, a hash, an object id); or 16 or more letters, digits, `_`, `-` or `.` in
 * which a letter meets a digit, or a capital follows a small letter, at least three times
 * (base64url and base62 tokens, JWTs). A share link, an invite or a reset carries its capability
 * in the path, and a landing path is kept and shown in reports, so such a run never leaves this
 * server. A slug rarely matches;
 * a long CamelCase name can, and costs only its page name.
 */
const SECRET_PATH_SEGMENT =
  /^(?:[\dA-Fa-f]{8}(?:-[\dA-Fa-f]{4}){3}-[\dA-Fa-f]{12}|[\dA-Fa-f]{16,}|(?=(?:.*?(?:[A-Za-z]\d|\d[A-Za-z]|[a-z][A-Z])){3})[\w.-]{16,})$/;

/**
 * What separates token runs: `/`, and any other character or percent-escape, so each id in a
 * bulk share link (`/share/<id>,<id>`) is tested on its own rather than as one segment.
 */
const PATH_SEPARATORS = /((?:%[\dA-Fa-f]{2}|[^\w.-])+)/;

/** What a browser's `location.pathname` can hold: printable ASCII less the path percent-encode set. */
const BROWSER_PATH = /^\/[\w!$%&'()*+,./:;=@[\]^|~-]*$/;

/** An http(s) URL's origin, or undefined for anything else. */
export function referrerOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A landing path fit to keep: the path alone, cut at any `?` or `#`, with each secret-shaped
 * run replaced and at most {@link MAX_LANDING_PATH} characters. Undefined when the value is not
 * a path a browser could send, or when it holds an address (`@`, or `%40` encoded), which is
 * never sent at all.
 */
export function cleanLandingPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const path = raw.split(/[?#]/)[0];
  if (!BROWSER_PATH.test(path) || /@|%40/i.test(path)) return undefined;
  return path
    .split(PATH_SEPARATORS)
    .map(part => (SECRET_PATH_SEGMENT.test(part) ? PATH_SECRET_PLACEHOLDER : part))
    .join('')
    .slice(0, MAX_LANDING_PATH);
}

/** The beacon body's referrer and landing path, each kept only when it passes its check. */
export function readVisitLanding(body: unknown): { referrer?: string; landingPath?: string } {
  if (!body || typeof body !== 'object') return {};
  const { referrer, landingPath } = body as Record<string, unknown>;
  const origin = referrerOrigin(referrer);
  const path = cleanLandingPath(landingPath);
  return { ...(origin !== undefined && { referrer: origin }), ...(path !== undefined && { landingPath: path }) };
}
