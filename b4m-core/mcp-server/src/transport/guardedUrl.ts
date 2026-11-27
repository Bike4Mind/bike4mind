const BAD_SEGMENT = /[/\\]|%2f|%5c/i;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isDotSegment(value: string): boolean {
  return value === '.' || value === '..';
}

/**
 * Resolves `template` (`/api/x/{id}`) under `baseUrl` for routes that have no SDK contract. A path value that could
 * change which route is hit (empty, a dot segment, a slash or backslash in any encoding) is refused, each value is
 * encoded, and the resolved path must re-split into exactly the template's segments. `baseUrl` comes from config,
 * never from tool arguments.
 */
export function buildGuardedUrl(
  baseUrl: string,
  template: string,
  params: Record<string, string> = {},
  query: Record<string, string | number | boolean | undefined> = {}
): string {
  const base = new URL(baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.search || base.hash) {
    throw new Error(`baseUrl must be an http(s) URL with no query or fragment, got ${JSON.stringify(baseUrl)}`);
  }

  const encoded: Record<string, string> = {};
  const path = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    const decoded = typeof value === 'string' ? safeDecode(value) : null;
    if (
      typeof value !== 'string' ||
      value === '' ||
      decoded === null ||
      isDotSegment(value) ||
      isDotSegment(decoded) ||
      BAD_SEGMENT.test(value) ||
      BAD_SEGMENT.test(decoded)
    ) {
      throw new Error(`Invalid path parameter ${name}: ${JSON.stringify(value)}`);
    }
    encoded[name] = encodeURIComponent(value);
    return encoded[name];
  });

  const prefix = base.pathname.replace(/\/+$/, '');
  const url = new URL(`${prefix}${path.startsWith('/') ? path : `/${path}`}`, base.origin);

  const expected = path.split('/');
  const actual = url.pathname.slice(prefix.length).split('/');
  const matches =
    actual.length === expected.length &&
    url.pathname.startsWith(prefix) &&
    expected.every((seg, i) => seg === actual[i]);
  if (!matches) throw new Error(`Resolved path ${JSON.stringify(url.pathname)} does not match ${template}`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.append(key, String(value));
  }
  return url.toString();
}
