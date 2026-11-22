import { BLESSED_SCRIPT_PATHS } from '@bike4mind/common';

export const LIBRARY_FETCH_TIMEOUT_MS = 8000;

// Comments and whole script elements, so a tag inside a comment or another script's body is never rewritten.
// Comment forms follow the HTML parser: `<!-->` and `<!--->` are empty, `--!>` closes, an unterminated one runs to the end.
// Group 1 is the open tag's attributes, undefined for a comment. A quote delimits only right after `=`, so a stray or
// apostrophe quote cannot swallow the page, while `>` inside a quoted value still does not end the tag.
const COMMENT_OR_SCRIPT =
  /<!--(?:-?>|[\s\S]*?(?:--!?>|$))|<script\b((?:[^>=]|=(?:\s*"[^"]*"|\s*'[^']*'|(?!\s*["'])))*)>(?:[\s\S]*?<\/script\s*>)?/gi;

// Captures: 1 name (may start with a quote or `=`, as in HTML), then the value as 2 (double-quoted), 3 (single-quoted)
// or 4 (unquoted, may hold quotes).
const ATTRIBUTE = /([^\s/>][^\s/>=]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>][^\s>]*)))?/g;

interface BlessedScript {
  path: string;
  quote: string;
  before: string;
  after: string;
  // An inline script cannot honor on* handlers, async or defer, so these keep an external src.
  externalOnly: boolean;
}

const parseBlessedScript = (attrs: string, blessed: Set<string>): BlessedScript | null => {
  let script: Omit<BlessedScript, 'externalOnly'> | undefined;
  let sawSrc = false;
  let externalOnly = false;

  for (const match of attrs.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (name === 'src') {
      if (sawSrc) return null;
      sawSrc = true;
      const path = match[2] ?? match[3] ?? match[4];
      if (path === undefined || !blessed.has(path)) continue;
      script = {
        path,
        quote: match[3] !== undefined ? "'" : '"',
        before: attrs.slice(0, match.index),
        after: attrs.slice(match.index + match[0].length),
      };
    } else if (name === 'async' || name === 'defer' || /^on[a-z]+$/.test(name)) {
      externalOnly = true;
    }
  }

  return script ? { ...script, externalOnly } : null;
};

const buildScriptTag = (attrParts: string[], body: string): string => {
  const attrs = attrParts.map(part => part.trim()).filter(part => part !== '' && part !== '/');
  return `<script${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>${body}</script>`;
};

const escapeInlineScript = (code: string): string => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const fetchLibrary = async (url: string, timeoutMs: number): Promise<string | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Make an HTML artifact's root-relative blessed `<script src>` (see BLESSED_SCRIPT_PATHS) work outside
 * the app host by inlining the library text, so a downloaded file renders offline. A library that
 * cannot be fetched in time, and any tag with on* handlers, async or defer, gets the absolute
 * app-origin URL instead. Comments and other scripts' bodies are skipped. Never throws; non-blessed srcs are untouched.
 */
export const inlineBlessedScripts = async (
  htmlContent: string,
  { timeoutMs = LIBRARY_FETCH_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<string> => {
  if (typeof window === 'undefined') return htmlContent;
  const origin = window.location.origin;
  const blessed = new Set<string>(BLESSED_SCRIPT_PATHS);

  const paths = new Set<string>();
  let touched = false;
  for (const match of htmlContent.matchAll(COMMENT_OR_SCRIPT)) {
    if (match[1] === undefined) continue;
    const script = parseBlessedScript(match[1], blessed);
    if (!script) continue;
    touched = true;
    if (!script.externalOnly) paths.add(script.path);
  }
  if (!touched) return htmlContent;

  const libraries = new Map<string, string | null>();
  await Promise.all(
    [...paths].map(async path => {
      libraries.set(path, await fetchLibrary(`${origin}${path}`, timeoutMs));
    })
  );

  return htmlContent.replace(COMMENT_OR_SCRIPT, (match, attrs: string | undefined) => {
    if (attrs === undefined) return match;
    const script = parseBlessedScript(attrs, blessed);
    if (!script) return match;
    const code = script.externalOnly ? null : libraries.get(script.path);
    if (code == null) {
      const src = `src=${script.quote}${origin}${script.path}${script.quote}`;
      return buildScriptTag([script.before, src, script.after], '');
    }
    return buildScriptTag([script.before, script.after], escapeInlineScript(code));
  });
};
