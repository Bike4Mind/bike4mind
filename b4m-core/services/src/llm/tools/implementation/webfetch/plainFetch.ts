import * as cheerio from 'cheerio';
import { htmlToMarkdown } from '../../../../lib/turndown';
import { unsafeFetchUrlReason } from './ssrfGuard';

const DEFAULT_PLAIN_FETCH_TIMEOUT_MS = 60_000;

export interface PlainFetchResult {
  markdown: string;
  title?: string;
}

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/**
 * Keyless web-page reader: a direct server-side fetch + HTML->markdown, used as the web_fetch /
 * deep_research fallback when Firecrawl is not configured (self-host).
 *
 * Unlike Firecrawl (which fetches on its own infra and is SSRF-immune by construction), this dials
 * the model/user-supplied URL directly, so it MUST pass the SSRF guard and use redirect:'error' so a
 * public origin cannot 302-pivot to an internal address after the check (see ssrfGuard.ts). Returns
 * the FULL extracted markdown; callers window/cap it (web_fetch to WEB_FETCH_CONTENT_CAP,
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

  const unsafe = await unsafeFetchUrlReason(new URL(url));
  if (unsafe) {
    throw new Error(`Refusing to fetch ${url}: ${unsafe}`);
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLAIN_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch content from URL: HTTP ${res.status} ${res.statusText}`);
    }
    html = await res.text();
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
