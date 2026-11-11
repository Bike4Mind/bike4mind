// Import-free on purpose: proxy.ts imports this module too, so keep it dependency-light.

type TokenPathRule = {
  /** Path segments before the token, compared decoded and case-insensitively. */
  prefix: string[];
  /** Segments between the prefix and the token (the QA report's run id). */
  skip?: number;
  /** Static sibling routes under the prefix whose segment is not a token. */
  except?: string[];
};

// Routes that carry a bearer token as a path segment by design (a hyperlink, a new-tab page or a
// provider-registered webhook URL can't send a header), so app log lines carry that segment redacted.
// Share links: every prefix that reaches the share-link branch of parsePublishPath: the viewer route
// (`/a/`), the `/p/a/` and `/uc/a/` rewrites (next.config.mjs) and the serve API itself.
// Must stay in sync with the `[token]` routes under pages/api named below.
const TOKEN_PATH_RULES: TokenPathRule[] = [
  { prefix: ['a'] },
  { prefix: ['p', 'a'] },
  { prefix: ['uc', 'a'] },
  { prefix: ['api', 'publish', 'serve', 'a'] },
  // pages/api/admin/qa/report/[runId]/[token]/[...path].ts
  { prefix: ['api', 'admin', 'qa', 'report'], skip: 1 },
  // pages/api/skills/market/by-token/[token].ts (deprecated; the index route reads a header)
  { prefix: ['api', 'skills', 'market', 'by-token'] },
  // pages/api/file-links/[token].ts
  { prefix: ['api', 'file-links'] },
  // pages/api/webhooks/github/[token].ts
  { prefix: ['api', 'webhooks', 'github'], except: ['lake', 'sre', 'subscriptions'] },
  // pages/api/webhooks/jira/[token].ts
  { prefix: ['api', 'webhooks', 'jira'], except: ['config', 'subscriptions'] },
];

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

// Any query parameter whose name contains "token" (`token`, `shareToken`, `access_token`, ...), so
// a caller that logs the full URL instead of the pathname still never logs a token value.
const TOKEN_PARAM = /([?&;][^=&;#]*token[^=&;#]*=)[^&;#]*/gi;

function redactTokenParams(suffix: string): string {
  return suffix.replace(TOKEN_PARAM, '$1[redacted]');
}

// Segments are compared decoded (the serve route resolves from decoded query segments, so `%61` is
// served as `a`) and case-insensitively; over-redacting a non-token path is harmless. The query
// string keeps its shape with token parameter values redacted (redactTokenParams).
export function redactTokenPath(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? '' : redactTokenParams(url.slice(cut));
  const parts = path.split('/');
  const indexes = parts.flatMap((part, i) => (part ? [i] : []));
  const decoded = indexes.map(i => decodeSegment(parts[i]));
  for (const { prefix, skip = 0, except = [] } of TOKEN_PATH_RULES) {
    const tokenAt = prefix.length + skip;
    if (decoded.length <= tokenAt || !prefix.every((segment, k) => decoded[k] === segment)) continue;
    if (except.includes(decoded[tokenAt])) continue;
    parts[indexes[tokenAt]] = '[redacted]';
    return parts.join('/') + suffix;
  }
  return path + suffix;
}

/** Log-safe form of a request URL: drops an identifier search's query and redacts path and query tokens. */
export function requestLogUrl(url: string): string {
  const pathname = url.split('?')[0];
  return pathname === '/api/admin/search' ? pathname : redactTokenPath(url);
}
