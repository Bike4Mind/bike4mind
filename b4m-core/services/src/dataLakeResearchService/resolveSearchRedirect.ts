export type SearchRedirectResolution = 'not_redirect' | 'decoded' | 'followed' | 'unresolved';

export type SearchRedirectVia = 'location' | 'refresh_header' | 'meta_refresh' | 'script' | 'anchor';

export interface UnresolvedDetail {
  reason:
    'status' | 'no_location' | 'google_location' | 'bad_location' | 'no_meta_refresh' | 'timeout' | 'network_error';
  status?: number;
  contentType?: string;
  locationHost?: string;
  bodyHint?: 'consent' | 'redirect_notice' | 'captcha' | 'verifying' | 'other';
  bodyTitle?: string;
  bodyLength?: number;
  hasRefreshHeader?: boolean;
  scriptRedirect?: boolean;
  externalLinks?: number;
}

export interface SearchRedirectResult {
  url: string;
  resolved: SearchRedirectResolution;
  via?: SearchRedirectVia;
  detail?: UnresolvedDetail;
  /** name=value pairs from the response, for that same link's retry only. Never log or store. */
  retryCookies?: string[];
}

export interface ResolveSearchRedirectOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cookies?: string[];
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 80;
const MAX_RETRY_COOKIES = 10;
const MAX_RETRY_COOKIE_BYTES = 4096;
const GOOGLE_REDIRECT_PATHS = new Set(['/goto', '/url']);

const isGoogleHost = (host: string): boolean => host === 'google.com' || host.endsWith('.google.com');

const GOOGLE_OWNED_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'gstatic.com',
  'googleusercontent.com',
  'googleapis.com',
  'g.co',
  'goo.gl',
];
const GOOGLE_COUNTRY_HOST = /(?:^|\.)google\.(?:com?\.)?[a-z]{2,3}$/;

const isGoogleOwnedHost = (host: string): boolean =>
  isGoogleHost(host) ||
  GOOGLE_OWNED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`)) ||
  GOOGLE_COUNTRY_HOST.test(host);

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

// Page-scraped targets are guessed, so Google-owned hosts (video, assets, country sites) are never the answer.
const scrapedDestination = (value: string | null | undefined): string | null => {
  const parsed = parseHttpUrl(value);
  return parsed && !isGoogleOwnedHost(parsed.hostname.toLowerCase()) ? parsed.toString() : null;
};

const refreshContentTarget = (content: string): string | null => {
  const target = /url\s*=\s*['"]?([^'";]+)/i.exec(content.replace(/&amp;/g, '&'));
  return nonGoogleDestination(target?.[1]?.trim());
};

const metaRefreshTarget = (html: string): string | null => {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return refreshContentTarget(content?.[1] ?? content?.[2] ?? '');
  }
  return null;
};

const SCRIPT_ASSIGNMENT = String.raw`(?<![\w$.])(?:(?:top|self|window|document|parent)\.)*location`;
const SCRIPT_LITERAL = String.raw`(["'])((?:\\.|(?!\1)[^\\\r\n]){0,2048})\1`;
const SCRIPT_REDIRECT = new RegExp(
  `${SCRIPT_ASSIGNMENT}(?:\\.(?:replace|assign)\\s*\\(|(?:\\.href)?\\s*=(?!=))\\s*${SCRIPT_LITERAL}`,
  'g'
);
const SCRIPT_REDIRECT_MARKER = new RegExp(
  `${SCRIPT_ASSIGNMENT}(?:\\.(?:replace|assign)\\s*\\(|(?:\\.href)?\\s*=(?!=))`
);

const unescapeJsString = (literal: string): string =>
  literal.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([\s\S]))/g, (_m, hex2, hex4, other) =>
    hex2 || hex4 ? String.fromCharCode(parseInt(hex2 ?? hex4, 16)) : other
  );

const scriptRedirectTarget = (body: string): string | null => {
  for (const match of body.matchAll(SCRIPT_REDIRECT)) {
    const target = scrapedDestination(unescapeJsString(match[2]).trim());
    if (target) return target;
  }
  return null;
};

const decodeHtmlEntities = (value: string): string =>
  value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|quot|apos|lt|gt));/g, (_m, dec, hex, name) => {
    if (name) return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name as string] ?? '';
    const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

const externalAnchorTargets = (body: string): string[] => {
  const found = new Set<string>();
  for (const tag of body.match(/<a\b[^>]*>/gi) ?? []) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const target = scrapedDestination(decodeHtmlEntities(href?.[1] ?? href?.[2] ?? '').trim());
    if (target) found.add(target);
  }
  return [...found];
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

const bodyTitleOf = (body: string): string | undefined => {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  const title = raw ? decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS) : '';
  return title || undefined;
};

const collectRetryCookies = (headers: Headers): string[] => {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const lines =
    withGetSetCookie.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  const pairs: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const pair = line.split(';')[0].trim();
    if (!pair.includes('=') || pair.startsWith('=')) continue;
    if (pairs.length >= MAX_RETRY_COOKIES || bytes + pair.length > MAX_RETRY_COOKIE_BYTES) break;
    pairs.push(pair);
    bytes += pair.length;
  }
  return pairs;
};

/** A 200 with no destination (or a timeout) may be a waiting page that releases later. */
export const isRetryableUnresolved = (detail: UnresolvedDetail | undefined): boolean =>
  Boolean(detail) &&
  (detail?.reason === 'timeout' ||
    (detail?.status === 200 &&
      detail.reason === 'no_meta_refresh' &&
      detail.bodyHint !== 'captcha' &&
      detail.bodyHint !== 'consent'));

// Coarse classification only, so a log line can tell a throttle page from a consent page.
const bodyHintFor = (body: string, title?: string): NonNullable<UnresolvedDetail['bodyHint']> => {
  const text = body.toLowerCase();
  if (text.includes('unusual traffic') || text.includes('/sorry/') || text.includes('captcha')) return 'captcha';
  if (text.includes('consent.google') || text.includes('before you continue')) return 'consent';
  if (text.includes('redirect notice')) return 'redirect_notice';
  if ((title ?? '').toLowerCase().includes('verif') || /verif/.test(text.replace(/<script[\s\S]*?<\/script>/g, ''))) {
    return 'verifying';
  }
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
      ...(opts.cookies?.length ? { headers: { Cookie: opts.cookies.join('; ') } } : {}),
      signal: controller.signal,
    });
    status = response.status;
    const contentType = response.headers.get('content-type')?.slice(0, 100) ?? undefined;
    const retryCookies = collectRetryCookies(response.headers);
    const unresolved = (detail: UnresolvedDetail): SearchRedirectResult => ({
      url,
      resolved: 'unresolved',
      detail: { ...detail, status: response.status, ...(contentType ? { contentType } : {}) },
      ...(retryCookies.length ? { retryCookies } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      const rawLocation = response.headers.get('location');
      const location = nonGoogleDestination(rawLocation);
      if (location) return { url: location, resolved: 'followed', via: 'location' };
      if (!rawLocation) return unresolved({ reason: 'no_location' });
      const locationHost = parseHttpUrl(rawLocation)?.hostname.toLowerCase();
      if (locationHost && isGoogleHost(locationHost)) return unresolved({ reason: 'google_location', locationHost });
      return unresolved({ reason: 'bad_location', ...(locationHost ? { locationHost } : {}) });
    }
    if (response.status === 200) {
      // Body reads share the timeout: a slow body must not stall the run.
      const body = await readCapped(response);
      const refreshHeader = response.headers.get('refresh');
      const headerTarget = refreshHeader ? refreshContentTarget(refreshHeader) : null;
      if (headerTarget) return { url: headerTarget, resolved: 'followed', via: 'refresh_header' };
      const metaTarget = metaRefreshTarget(body);
      if (metaTarget) return { url: metaTarget, resolved: 'followed', via: 'meta_refresh' };
      const bodyTitle = bodyTitleOf(body);
      const bodyHint = bodyHintFor(body, bodyTitle);
      const interstitial = bodyHint === 'captcha' || bodyHint === 'consent';
      const scriptTarget = interstitial ? null : scriptRedirectTarget(body);
      if (scriptTarget) return { url: scriptTarget, resolved: 'followed', via: 'script' };
      const anchors = externalAnchorTargets(body);
      if (!interstitial && anchors.length === 1) return { url: anchors[0], resolved: 'followed', via: 'anchor' };
      return unresolved({
        reason: 'no_meta_refresh',
        bodyHint,
        ...(bodyTitle ? { bodyTitle } : {}),
        bodyLength: body.length,
        hasRefreshHeader: Boolean(refreshHeader),
        scriptRedirect: SCRIPT_REDIRECT_MARKER.test(body),
        externalLinks: anchors.length,
      });
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
