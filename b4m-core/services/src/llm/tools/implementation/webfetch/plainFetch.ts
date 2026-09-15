import * as cheerio from 'cheerio';
import { htmlToMarkdown } from '../../../../lib/turndown';
import { resolveAndVetUrl } from './ssrfGuard';

const DEFAULT_PLAIN_FETCH_TIMEOUT_MS = 60_000;
// Hard ceiling on a fetched body. deep_research fetches up to 3 URLs in parallel, so an unbounded
// read of a large or hostile body could OOM the process; reject via content-length when present and
// abort the stream once this is exceeded.
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Only these are worth converting to markdown; anything else (binary, PDFs, images, archives) is
// rejected before the body is read so we never buffer a large non-text payload.
const READABLE_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export interface PlainFetchResult {
  markdown: string;
  title?: string;
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/** Read a response body as UTF-8 text, aborting once it exceeds maxBytes (streamed, not buffered whole first). */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return res.text(); // no stream to meter (unusual); the content-length pre-check already ran

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response body exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Keyless web-page reader: a direct server-side fetch + HTML->markdown, used as the web_fetch /
 * deep_research fallback when Firecrawl is not configured (self-host).
 *
 * Unlike Firecrawl (which fetches on its own infra and is SSRF-immune by construction), this dials
 * the model/user-supplied URL directly and returns its content, so it MUST pass the SSRF guard and
 * use redirect:'error' so a public origin cannot 302-pivot to an internal address after the check.
 * For http it pins the vetted IP (fetching the resolved address with the original Host header) so
 * fetch cannot re-resolve to a rebind target between the DNS check and the connection; for https it
 * keeps the hostname because TLS certificate validation already defeats rebind (an internal server
 * cannot present a valid cert for the attacker's hostname) and pinning would break SNI.
 *
 * Returns the FULL extracted markdown; callers window/cap it (web_fetch to WEB_FETCH_CONTENT_CAP,
 * deep_research to 10k). Known gaps vs Firecrawl: no headless browser (JS-heavy pages render poorly)
 * and no PDF parser - a PDF URL returns a clear message instead of garbage.
 */
export async function plainFetchScrape(url: string, options?: { timeoutMs?: number }): Promise<PlainFetchResult> {
  if (isPdfUrl(url)) {
    return {
      markdown:
        'This URL points to a PDF. The local plain-fetch reader cannot extract PDF content - ' +
        'configure Firecrawl (Admin > API Keys) or upload the PDF file directly instead.',
    };
  }

  const target = new URL(url);
  const vetted = await resolveAndVetUrl(target);
  if (!vetted.safe) {
    throw new Error(`Refusing to fetch ${url}: ${vetted.reason}`);
  }

  // Pin the vetted IP for http (see the function doc); https keeps the hostname.
  let fetchUrl = url;
  const headers: Record<string, string> = {};
  if (target.protocol === 'http:') {
    headers.Host = target.host;
    const pinned = new URL(target.toString());
    pinned.hostname = vetted.family === 6 ? `[${vetted.address}]` : vetted.address;
    fetchUrl = pinned.toString();
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLAIN_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  try {
    const res = await fetch(fetchUrl, { method: 'GET', redirect: 'error', headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch content from URL: HTTP ${res.status} ${res.statusText}`);
    }

    // A present content-type that is not a readable text type is rejected before the body is read.
    // A MISSING content-type is deliberately allowed through - many legitimate text/HTML origins omit
    // it, so we optimistically attempt extraction, bounded by the 5MB streamed read cap below; a
    // non-text body that yields no markdown still throws 'No content could be extracted' at the end.
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !READABLE_CONTENT_TYPES.some(t => contentType.includes(t))) {
      await res.body?.cancel().catch(() => {}); // don't buffer a binary / non-text payload
      throw new Error('No content could be extracted from the URL');
    }

    const declaredLength = res.headers.get('content-length');
    if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Refusing to fetch ${url}: response body exceeds the ${MAX_BODY_BYTES}-byte limit`);
    }

    html = await readCappedText(res, MAX_BODY_BYTES);
  } finally {
    clearTimeout(timer);
  }

  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || undefined;
  const markdown = htmlToMarkdown(html);
  if (!markdown) {
    throw new Error('No content could be extracted from the URL');
  }
  return { markdown, title };
}
