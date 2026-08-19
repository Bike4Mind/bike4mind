/**
 * Canonical source identity for the acquisition proposal queue (#1671).
 *
 * The queue dedupes on WHERE content came from, not on what it said: the same page reached through a
 * campaign link, a mixed-case host or a fragment anchor is one source, and proposing it twice is the
 * failure dedup exists to prevent. The normalized-text hash (`computeServerTextHash`, admission
 * contract) is the secondary "changed materially" signal layered on top of this key - never a
 * replacement for it, because a page that changes text is still the same source.
 */

/**
 * Query parameters that identify a REFERRAL, not a resource. Stripping them is what collapses
 * campaign/share links onto the page they point at. Deliberately a fixed list rather than a
 * heuristic: a wrong guess here silently merges two distinct sources into one queue entry.
 */
const TRACKING_PARAM_PREFIXES = ['utm_', 'pk_', 'mc_', 'hsa_', 'vero_', 'ns_'];
const TRACKING_PARAM_NAMES = new Set([
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'igshid',
  'yclid',
  'mkt_tok',
  'ref',
  'ref_src',
  'referrer',
  'source',
  's_kwcid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'trk',
  'spm',
]);

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

const isTrackingParam = (name: string): boolean => {
  const lowered = name.toLowerCase();
  return TRACKING_PARAM_NAMES.has(lowered) || TRACKING_PARAM_PREFIXES.some(prefix => lowered.startsWith(prefix));
};

/** Parse as an http(s) URL, or null. Every other scheme is out of scope for an acquisition source. */
const parseHttpUrl = (raw: string): URL | null => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
};

/**
 * The stable identity of a proposed source, or null when the input is not an http(s) URL (a producer
 * that cannot name its source in a URL gets no source-keyed dedup - the text hash still applies).
 *
 * Normalization, and the reason for each: scheme + host lowercased (case-insensitive by RFC 3986, so
 * a case difference is never a different resource); default port dropped (`:443` is the same origin
 * as none); fragment dropped (client-side anchor, never reaches the server); credentials stripped
 * (this value is persisted and shown to reviewers, so it must not be able to carry a secret);
 * tracking parameters stripped; surviving parameters sorted so `?a=1&b=2` and `?b=2&a=1` are one key.
 *
 * Deliberately NOT normalized: the path's case and trailing slash (servers routinely treat those as
 * distinct resources) and http-vs-https (a different origin, not a spelling).
 */
export function canonicalSourceKey(rawUrl: string): string | null {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return null;

  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  if (parsed.port === DEFAULT_PORTS[parsed.protocol]) parsed.port = '';

  // Rebuilt from entries rather than by deleting in place: URLSearchParams.delete removes every
  // value of a name, and sorting is what makes parameter order a non-difference.
  const kept = Array.from(parsed.searchParams.entries()).filter(([name]) => !isTrackingParam(name));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = '';
  for (const [name, value] of kept) parsed.searchParams.append(name, value);

  // `URL` lowercases the scheme and host itself; toString() then emits the canonical form.
  return parsed.toString();
}

/**
 * The source URL as RECORDED on a proposal and on the file it admits - the original link minus any
 * embedded credentials. Distinct from `canonicalSourceKey`: reviewers need the URL they can actually
 * open (tracking parameters and fragment intact), while the key exists only to be compared. Returns
 * null when the input is not an http(s) URL, so a caller records nothing rather than a guess.
 */
export function sanitizeSourceUrlForRecord(rawUrl: string): string | null {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return null;
  if (!parsed.username && !parsed.password) return parsed.toString();
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}
