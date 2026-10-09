import type { Request } from 'express';

type RouteRequest = Pick<Request, 'originalUrl' | 'url' | 'query'>;

/**
 * Collapses a request URL to its Next.js route template (`/api/agents/abc?x=1` ->
 * `/api/agents/[id]`) so stored usage groups by route and never keeps a query string.
 *
 * Next.js merges the matched route's dynamic params into `req.query`, so a path segment that
 * equals a param value is that param's slot. Catch-all params (array values) collapse to
 * `[...key]`. A literal segment that happens to equal a param value is indistinguishable
 * from the param, which is why this runs from the route match and not on stored URLs.
 */
export function resolveRouteTemplate(req: RouteRequest): string {
  const raw = req.originalUrl || req.url || '';
  const pathname = raw.split(/[?#]/, 1)[0] || '/';
  const segments = pathname.split('/');

  // req.query also carries the real query string (a repeated key becomes an array), and Next.js
  // lets a route param override a query key of the same name. A value that equals the query
  // string's own values for that key is indistinguishable from a query-only key, and letting it
  // claim segments would mis-template (`/api/x/1?n=1`) or let a caller spoof the template
  // (`?z=api&z=admin`), so it is skipped. A differing value can only be a route param, so a
  // colliding name (`?path=1` on a `[...path]` route) still gets templated.
  const search = new URLSearchParams(raw.split('#', 1)[0].split('?').slice(1).join('?'));
  const params = Object.entries(req.query ?? {}).filter((entry): entry is [string, string | string[]] => {
    const [key, value] = entry;
    const values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values) || !values.every(v => typeof v === 'string')) return false;
    const fromSearch = search.getAll(key);
    return !(fromSearch.length === values.length && fromSearch.every((v, i) => v === values[i]));
  });

  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = safeDecode(segments[i]);
    if (!segment) {
      out.push(segments[i]);
      continue;
    }

    const catchAll = params.find(
      ([key, value]) =>
        !used.has(key) &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((part, offset) => safeDecode(segments[i + offset] ?? '') === part)
    );
    if (catchAll) {
      used.add(catchAll[0]);
      out.push(`[...${catchAll[0]}]`);
      i += (catchAll[1] as string[]).length - 1;
      continue;
    }

    const single = params.find(([key, value]) => !used.has(key) && value === segment);
    if (single) {
      used.add(single[0]);
      out.push(`[${single[0]}]`);
      continue;
    }

    out.push(segments[i]);
  }

  return out.join('/') || '/';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
