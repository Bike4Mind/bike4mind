/**
 * Data origins that Python artifact code may fetch from: the `pythonArtifactDataOrigins` admin
 * setting. Every reader goes through this module so they cannot disagree about what is listed:
 * the settings update route refuses a bad entry, `/api/pyodide-sandbox` adds the result to its
 * `connect-src`, the artifact-emission prompt names it to the model and the Python viewer shows it.
 *
 * Browser-safe on purpose (the viewer imports it), so a caller that wants the app's whole site
 * reserved passes its own registrable-domain function to {@link pythonDataOriginReservedHosts}.
 */

export const PYTHON_ARTIFACT_DATA_ORIGINS_MAX = 10;

// Top-level names that never reach a public host: RFC 6761/6762 special-use names, RFC 8375's
// home.arpa (and the rest of .arpa), and names private networks commonly use.
const NON_PUBLIC_TLDS = new Set([
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion',
  'alt',
]);

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// Scheme and authority, then at most a bare trailing slash. Rules out a path, query, fragment and
// user info before the URL parser can normalize any of them away.
const ORIGIN_SHAPE = /^https:\/\/[^/?#@\\\s]+\/?$/i;

export type PythonDataOriginParse = { origin: string; problem?: undefined } | { origin?: undefined; problem: string };

/**
 * Parse one admin-entered entry into a canonical origin (`https://host[:port]`, lowercase, no
 * default port), or say why it is refused. `reservedHosts` are hosts that may not be listed, each
 * covering its subdomains; see {@link pythonDataOriginReservedHosts}.
 */
export function parsePythonDataOrigin(raw: unknown, reservedHosts: readonly string[] = []): PythonDataOriginParse {
  if (typeof raw !== 'string') return { problem: 'must be text' };
  const value = raw.trim();
  if (!value) return { problem: 'is empty' };
  if (value.includes('*')) return { problem: 'wildcards are not allowed' };
  if (!/^https:\/\//i.test(value)) return { problem: 'must start with https://' };
  if (!ORIGIN_SHAPE.test(value)) {
    return { problem: 'must be an origin only, with no path, query, fragment or user info' };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: 'is not a valid URL' };
  }

  const host = url.hostname;
  // The URL parser rewrites numeric hosts such as 2130706433 or 0x7f.1 to dotted IPv4, so this
  // check sees every spelling of an IPv4 literal.
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return { problem: 'IP addresses are not allowed' };

  // Wildcard-DNS names (127.0.0.1.nip.io) resolve to the address they spell, so they are IP literals too.
  if (host.length > 253) return { problem: 'must name a public hostname such as data.example.com' };
  if (/(^|\.)\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}(\.|$)/.test(host)) {
    return { problem: 'IP addresses are not allowed' };
  }
  if (url.port === '0') return { problem: 'port 0 is not allowed' };

  const labels = host.split('.');
  const tld = labels[labels.length - 1]!;
  if (NON_PUBLIC_TLDS.has(tld)) return { problem: 'local and private hostnames are not allowed' };
  if (labels.length < 2 || !labels.every(label => HOST_LABEL.test(label))) {
    return { problem: 'must name a public hostname such as data.example.com' };
  }

  if (reservedHosts.some(reserved => host === reserved || host.endsWith(`.${reserved}`))) {
    return { problem: "this app's own hosts are not allowed" };
  }

  return { origin: url.origin };
}

/**
 * Split a list into canonical origins (deduplicated, in entry order) and refused entries with the
 * reason for each. Non-array input yields nothing.
 */
export function partitionPythonDataOrigins(
  entries: unknown,
  reservedHosts: readonly string[] = []
): { valid: string[]; invalid: { entry: string; problem: string }[] } {
  const valid = new Set<string>();
  const invalid: { entry: string; problem: string }[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const parsed = parsePythonDataOrigin(entry, reservedHosts);
    if (parsed.origin !== undefined) valid.add(parsed.origin);
    else invalid.push({ entry: String(entry), problem: parsed.problem });
  }
  return { valid: [...valid], invalid };
}

/**
 * The origins to apply for a stored setting value. All or nothing: one refused entry, or more than
 * {@link PYTHON_ARTIFACT_DATA_ORIGINS_MAX}, applies none, so a bad stored value can only take
 * network access away and never puts an unchecked source into a CSP header.
 */
export function resolvePythonArtifactDataOrigins(stored: unknown, reservedHosts: readonly string[] = []): string[] {
  if (!Array.isArray(stored)) return [];
  const { valid, invalid } = partitionPythonDataOrigins(stored, reservedHosts);
  if (invalid.length > 0 || valid.length > PYTHON_ARTIFACT_DATA_ORIGINS_MAX) return [];
  return valid;
}

/**
 * Hosts a data origin may not name: each app URL's host plus, when `siteOf` is given, its
 * registrable domain, so the app's API and every other host on its site are covered too.
 */
export function pythonDataOriginReservedHosts(
  appUrls: readonly (string | undefined)[],
  siteOf?: (host: string) => string | null
): string[] {
  const hosts = new Set<string>();
  for (const appUrl of appUrls) {
    if (!appUrl) continue;
    let host: string;
    try {
      host = new URL(appUrl).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;
    hosts.add(host);
    const site = siteOf?.(host);
    if (site) hosts.add(site.toLowerCase());
  }
  return [...hosts];
}

/**
 * The artifact-emission prompt with a note naming the data origins appended, or the prompt
 * unchanged when none are listed.
 */
export function withPythonDataOrigins(prompt: string, origins: readonly string[]): string {
  if (origins.length === 0) return prompt;
  return `${prompt}\n\n${pythonDataOriginsPromptNote(origins)}`;
}

export function pythonDataOriginsPromptNote(origins: readonly string[]): string {
  return (
    `PYTHON DATA ORIGINS: Python artifact code may read data over HTTPS from these origins only: ${origins.join(', ')}. ` +
    'Fetch with `from pyodide.http import pyfetch` and `resp = await pyfetch(url)` (top-level await works; then ' +
    '`await resp.json()` or `await resp.string()`), or synchronously with `from pyodide.http import open_url` ' +
    '(returns a text file object, e.g. `pd.read_csv(open_url(url))`). Requests carry no cookies or credentials and ' +
    'the origin must allow cross-origin reads. Every other address is blocked, including this app, and urllib, ' +
    'requests and pd.read_csv(url) do not work. HTML and React artifacts still have no network.'
  );
}
