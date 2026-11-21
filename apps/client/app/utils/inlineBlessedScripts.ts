import { BLESSED_SCRIPT_PATHS } from '@bike4mind/common';

// Captures: 1 attrs before src, 2 quote, 3 src, 4 attrs after src, then an optional body + closing tag.
// Same whitespace-anchored `\s+src` as absolutizeBlessedScripts (htmlSanitizer.ts), so `data-src` never matches.
const SCRIPT_TAG = /<script\b([^>]*?)\s+src\s*=\s*(["'])([^"']*)\2([^>]*)>(?:[\s\S]*?<\/script\s*>)?/gi;

const escapeInlineScript = (code: string): string =>
  code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const fetchLibrary = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
};

/**
 * Make an HTML artifact's root-relative blessed `<script src>` (see BLESSED_SCRIPT_PATHS) work outside
 * the app host by inlining the library text, so a downloaded file renders offline. A library that
 * cannot be fetched falls back to the absolute app-origin URL. Never throws; non-blessed srcs are untouched.
 */
export const inlineBlessedScripts = async (htmlContent: string): Promise<string> => {
  if (typeof window === 'undefined') return htmlContent;
  const origin = window.location.origin;
  const blessed = new Set<string>(BLESSED_SCRIPT_PATHS);

  const paths = new Set<string>();
  for (const match of htmlContent.matchAll(SCRIPT_TAG)) {
    if (blessed.has(match[3])) paths.add(match[3]);
  }
  if (paths.size === 0) return htmlContent;

  const libraries = new Map<string, string | null>();
  await Promise.all(
    [...paths].map(async path => {
      libraries.set(path, await fetchLibrary(`${origin}${path}`));
    })
  );

  return htmlContent.replace(SCRIPT_TAG, (match, before: string, quote: string, src: string, after: string) => {
    if (!blessed.has(src)) return match;
    const code = libraries.get(src);
    if (code == null) return `<script${before} src=${quote}${origin}${src}${quote}${after}></script>`;
    return `<script${before}${after}>${escapeInlineScript(code)}</script>`;
  });
};
