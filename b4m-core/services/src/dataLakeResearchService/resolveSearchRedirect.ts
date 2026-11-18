export type SearchRedirectResolution = 'not_redirect' | 'decoded' | 'followed' | 'unresolved';

export interface ResolveSearchRedirectOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 64 * 1024;
const GOOGLE_REDIRECT_PATHS = new Set(['/goto', '/url']);

const isGoogleHost = (host: string): boolean => host === 'google.com' || host.endsWith('.google.com');

const parseHttpUrl = (value: string | null | undefined, base?: string): URL | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value, base);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

const isRedirectLink = (url: URL): boolean =>
  (url.hostname === 'google.com' || url.hostname === 'www.google.com') && GOOGLE_REDIRECT_PATHS.has(url.pathname);

const nonGoogleDestination = (value: string | null | undefined): string | null => {
  // No base: a relative or scheme-less value is not a destination.
  const parsed = parseHttpUrl(value);
  return parsed && !isGoogleHost(parsed.hostname.toLowerCase()) ? parsed.toString() : null;
};

const metaRefreshTarget = (html: string): string | null => {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const target = /url\s*=\s*['"]?([^'";]+)/i.exec((content?.[1] ?? content?.[2] ?? '').replace(/&amp;/g, '&'));
    return nonGoogleDestination(target?.[1]?.trim());
  }
  return null;
};

const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, MAX_BODY_BYTES);
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (bytes < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text.slice(0, MAX_BODY_BYTES);
};

/**
 * Resolves a search-provider redirect link (Google /goto or /url) to the site it points at, so
 * source rules classify the real destination. Single hop, never throws, and only ever requests the
 * Google URL itself. An unresolved link comes back unchanged.
 */
export async function resolveSearchRedirect(
  url: string,
  opts: ResolveSearchRedirectOptions = {}
): Promise<{ url: string; resolved: SearchRedirectResolution }> {
  const parsed = parseHttpUrl(url);
  if (!parsed || !isRedirectLink(parsed)) return { url, resolved: 'not_redirect' };

  if (parsed.pathname === '/url') {
    const decoded = nonGoogleDestination(parsed.searchParams.get('q') ?? parsed.searchParams.get('url'));
    if (decoded) return { url: decoded, resolved: 'decoded' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = nonGoogleDestination(response.headers.get('location'));
      if (location) return { url: location, resolved: 'followed' };
    } else if (response.status === 200) {
      // Body reads share the timeout: a slow body must not stall the run.
      const target = metaRefreshTarget(await readCapped(response));
      if (target) return { url: target, resolved: 'followed' };
    }
    return { url, resolved: 'unresolved' };
  } catch {
    return { url, resolved: 'unresolved' };
  } finally {
    clearTimeout(timer);
  }
}
