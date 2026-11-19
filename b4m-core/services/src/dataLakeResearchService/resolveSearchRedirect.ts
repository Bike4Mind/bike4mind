export type SearchRedirectResolution = 'not_redirect' | 'decoded' | 'followed' | 'unresolved';

export interface UnresolvedDetail {
  reason:
    'status' | 'no_location' | 'google_location' | 'bad_location' | 'no_meta_refresh' | 'timeout' | 'network_error';
  status?: number;
  contentType?: string;
  locationHost?: string;
  bodyHint?: 'consent' | 'redirect_notice' | 'captcha' | 'other';
}

export interface SearchRedirectResult {
  url: string;
  resolved: SearchRedirectResolution;
  detail?: UnresolvedDetail;
}

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

// Coarse classification only, so a log line can tell a throttle page from a consent page.
const bodyHintFor = (body: string): NonNullable<UnresolvedDetail['bodyHint']> => {
  const text = body.toLowerCase();
  if (text.includes('unusual traffic') || text.includes('/sorry/') || text.includes('captcha')) return 'captcha';
  if (text.includes('consent.google') || text.includes('before you continue')) return 'consent';
  if (text.includes('redirect notice')) return 'redirect_notice';
  return 'other';
};

/**
 * Resolves a search-provider redirect link (Google /goto or /url) to the site it points at, so
 * source rules classify the real destination. Single hop, never throws, and only ever requests the
 * Google URL itself. An unresolved link comes back unchanged.
 */
export async function resolveSearchRedirect(
  url: string,
  opts: ResolveSearchRedirectOptions = {}
): Promise<SearchRedirectResult> {
  const parsed = parseHttpUrl(url);
  if (!parsed || !isRedirectLink(parsed)) return { url, resolved: 'not_redirect' };

  if (parsed.pathname === '/url') {
    const decoded = nonGoogleDestination(parsed.searchParams.get('q') ?? parsed.searchParams.get('url'));
    if (decoded) return { url: decoded, resolved: 'decoded' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let status: number | undefined;
  try {
    const response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
    });
    status = response.status;
    const contentType = response.headers.get('content-type')?.slice(0, 100) ?? undefined;
    const unresolved = (detail: UnresolvedDetail): SearchRedirectResult => ({
      url,
      resolved: 'unresolved',
      detail: { ...detail, status: response.status, ...(contentType ? { contentType } : {}) },
    });
    if (response.status >= 300 && response.status < 400) {
      const rawLocation = response.headers.get('location');
      const location = nonGoogleDestination(rawLocation);
      if (location) return { url: location, resolved: 'followed' };
      if (!rawLocation) return unresolved({ reason: 'no_location' });
      const locationHost = parseHttpUrl(rawLocation)?.hostname.toLowerCase();
      if (locationHost && isGoogleHost(locationHost)) return unresolved({ reason: 'google_location', locationHost });
      return unresolved({ reason: 'bad_location', ...(locationHost ? { locationHost } : {}) });
    }
    if (response.status === 200) {
      // Body reads share the timeout: a slow body must not stall the run.
      const body = await readCapped(response);
      const target = metaRefreshTarget(body);
      if (target) return { url: target, resolved: 'followed' };
      return unresolved({ reason: 'no_meta_refresh', bodyHint: bodyHintFor(body) });
    }
    if (response.status >= 400 && response.status < 500) {
      return unresolved({ reason: 'status', bodyHint: bodyHintFor(await readCapped(response)) });
    }
    return unresolved({ reason: 'status' });
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    return {
      url,
      resolved: 'unresolved',
      detail: { reason: timedOut ? 'timeout' : 'network_error', ...(status !== undefined ? { status } : {}) },
    };
  } finally {
    clearTimeout(timer);
  }
}
