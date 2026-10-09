/**
 * Spotting a credential the model put where only key NAMES belong: an argument, a URL.
 *
 * A heuristic, tuned to flag rather than to be right: a flag puts a warning on the card and tells
 * the model to use env_keys, and the user can still approve a false positive. What it returns
 * names WHERE the value is and never repeats the value, because the result reaches the model.
 */

/** Prefixes vendors put on their tokens precisely so scanners like this can find them. */
const TOKEN_PREFIXES =
  /^(sk-|sk_live_|sk_test_|rk_live_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abposr]-|hf_|npm_|pypi-|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza|ya29\.|shpat_|shpss_|dop_v1_|SG\.|lin_api_|ntn_|secret_)/;

/** `--token`, `api_key=`, `X-Api-Key:` and the like: a name that announces a secret follows. */
const SECRET_NAME =
  /(token|secret|passw(or)?d|api[-_]?key|apikey|auth|credential|private[-_]?key|access[-_]?key|bearer)/i;

const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** Long enough that a word or a version string does not qualify; a 40-char SHA does, see below. */
const MIN_OPAQUE_CHARS = 32;

export interface SecretFlag {
  /** Where, as the card and the model read it: "argument 3", "the URL". */
  where: string;
  why: string;
  /** For an argument, its position in args. */
  index?: number;
}

/** Bits per character over the string's own alphabet. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Whether one bare value reads as a credential. Paths, URLs, package specs and flags are skipped
 * by the character class: a token is one run of [A-Za-z0-9_+=-], and those all contain `/`, `@`,
 * `.` or start with `-`. Mixed case or letters-with-digits AND high entropy is required, so a long
 * hex commit SHA or a lowercase slug does not trip it.
 */
export function looksLikeSecret(value: string): string | null {
  const trimmed = value.trim();
  if (TOKEN_PREFIXES.test(trimmed) && trimmed.length >= 16) return 'starts like a vendor API token';
  if (JWT.test(trimmed)) return 'is a signed token (JWT)';
  if (/^Bearer\s+\S{8,}/i.test(trimmed)) return 'is a bearer token';
  if (trimmed.length < MIN_OPAQUE_CHARS || !/^[A-Za-z0-9_+=-]+$/.test(trimmed) || trimmed.startsWith('-')) return null;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter(pattern => pattern.test(trimmed)).length;
  if (classes >= 2 && entropy(trimmed) >= 4) return 'is a long random-looking string';
  return null;
}

/**
 * Flags across a stdio server's arguments. `--token VALUE` and `--token=VALUE` are flagged on the
 * name alone whatever the value looks like: the name is the author saying it is a secret.
 */
export function scanArgs(args: readonly string[]): SecretFlag[] {
  const flags: SecretFlag[] = [];
  args.forEach((arg, index) => {
    const where = `argument ${index + 1}`;
    const flag = (why: string) => flags.push({ where, why, index });
    const assigned = /^-{0,2}([A-Za-z0-9_.-]+)=(.+)$/.exec(arg);
    if (assigned && SECRET_NAME.test(assigned[1])) {
      flag(`sets ${assigned[1]}, which names a secret`);
      return;
    }
    const previous = index > 0 ? args[index - 1] : '';
    if (/^-{1,2}[A-Za-z]/.test(previous) && SECRET_NAME.test(previous) && !arg.startsWith('-')) {
      flag(`is the value of ${previous}, which names a secret`);
      return;
    }
    const why = looksLikeSecret(assigned ? assigned[2] : arg);
    if (why) flag(why);
  });
  return flags;
}

const HIDDEN = '[hidden: looks like a secret]';

/**
 * A server's args and URL as the MODEL may see them: flagged arguments replaced, and a URL that
 * carries a credential cut back to its origin. The card shows the real values to the user; this
 * is for listings, results and the call input the transcript replays, which can hold a key the
 * user typed into Customize -> MCP rather than into a secret field.
 */
export function maskForModel(server: { args?: readonly string[]; url?: string }): { args?: string[]; url?: string } {
  const out: { args?: string[]; url?: string } = {};
  if (server.args) {
    const hidden = new Set(scanArgs(server.args).map(flag => flag.index));
    out.args = server.args.map((arg, index) => (hidden.has(index) ? HIDDEN : arg));
  }
  if (server.url !== undefined) {
    let origin = server.url;
    try {
      origin = new URL(server.url).origin;
    } catch {
      // Not a URL; scanUrl flags nothing in it either.
    }
    out.url = scanUrl(server.url).length > 0 ? `${origin}/${HIDDEN}` : server.url;
  }
  return out;
}

/** Flags in an http server's URL: a password in it, or a query parameter that names or looks like a secret. */
export function scanUrl(raw: string): SecretFlag[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const flags: SecretFlag[] = [];
  if (url.password) flags.push({ where: 'the URL', why: 'contains a password' });
  for (const [name, value] of url.searchParams) {
    if (SECRET_NAME.test(name) || /^key$/i.test(name)) {
      flags.push({ where: 'the URL', why: `has a "${name}" query parameter, which names a secret` });
    } else {
      const why = looksLikeSecret(value);
      if (why) flags.push({ where: 'the URL', why: `has a query parameter that ${why}` });
    }
  }
  for (const segment of url.pathname.split('/')) {
    const why = looksLikeSecret(decodeURIComponentSafe(segment));
    if (why) flags.push({ where: 'the URL', why: `has a path segment that ${why}` });
  }
  return flags;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
