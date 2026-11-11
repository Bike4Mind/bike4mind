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

// Segments are compared decoded (the serve route resolves from decoded query segments, so `%61` is
// served as `a`) and case-insensitively; over-redacting a non-token path is harmless.
export function redactTokenPath(url: string): string {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const parts = path.split('/');
  const indexes = parts.flatMap((part, i) => (part ? [i] : []));
  const decoded = indexes.map(i => decodeSegment(parts[i]));
  for (const { prefix, skip = 0, except = [] } of TOKEN_PATH_RULES) {
    const tokenAt = prefix.length + skip;
    if (decoded.length <= tokenAt || !prefix.every((segment, k) => decoded[k] === segment)) continue;
    if (except.includes(decoded[tokenAt])) continue;
    parts[indexes[tokenAt]] = '[redacted]';
    return parts.join('/') + (cut === -1 ? '' : url.slice(cut));
  }
  return url;
}

/** Log-safe form of a request URL: drops an identifier search's query and redacts a path token. */
export function requestLogUrl(url: string): string {
  const pathname = url.split('?')[0];
  return pathname === '/api/admin/search' ? pathname : redactTokenPath(url);
}
