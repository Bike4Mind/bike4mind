import type { ArtifactType } from '@bike4mind/common';

/**
 * Elision detection - the companion to the `max_tokens` truncation check in
 * ChatCompletionProcess. Truncation is a HARD stop at the output ceiling and ends mid-tag,
 * so it is detectable from the provider's stop reason alone. Elision is the quiet variant:
 * the model voluntarily abbreviates, finishes with a clean stop reason, and emits an
 * artifact that parses and renders while its behaviour is replaced by placeholder comments.
 * Visual review cannot catch it - the UI looks complete and the buttons silently do nothing.
 *
 * Three independent signals, deliberately weighted differently:
 *  - Placeholder comments, anchored to COMMENT context only. This is the whole reason the
 *    heuristic is shippable: an artifact whose prose or data legitimately contains "for
 *    brevity" must never trip it. High confidence on a single match, so each phrase must be
 *    one that has no innocent reading inside a comment.
 *  - Undefined references (calls, and inline HTML handlers, into functions that are never
 *    declared) are regex-derived and will misfire on exotic code, so they require
 *    corroboration (>= 2 distinct names) and report low confidence.
 *  - Hollow function bodies - declared, called, and containing nothing but a comment. Three
 *    or more is high confidence; one or two only corroborate, since a deliberate no-op is
 *    legitimate.
 *
 * ADVISORY ONLY. Callers must never drop, rewrite, or block content on this result - unlike
 * the truncation path, which force-closes a dangling tag. A false positive here is a slightly
 * wrong warning; a false positive that ate a good artifact would be a worse bug than the one
 * this module exists to catch.
 */

export type ElisionSignal =
  | { kind: 'placeholder_comment'; match: string; line: number }
  | { kind: 'undefined_reference'; name: string }
  | { kind: 'undefined_handler'; name: string; attribute: string }
  | { kind: 'empty_function_body'; name: string };

export interface ElisionResult {
  /** Crossed the reporting threshold - show an advisory "may be incomplete" affordance. */
  elided: boolean;
  /** 'high' for a placeholder comment or 3+ hollow bodies; corroborated references are 'low'. */
  confidence: 'high' | 'low';
  signals: ElisionSignal[];
}

/**
 * Stub-marker phrases, matched against COMMENT TEXT ONLY (never raw source). Sourced from
 * the real elided artifact in the originating bug plus the obvious siblings. Kept narrow on
 * purpose - each entry must be a phrase that has no business appearing in a comment inside a
 * finished deliverable. Notably absent: bare "TODO", which is common in legitimate scaffolding.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\.\.\.\s*\(?\s*same\b/i,
  /\[\s*\.\.\.\s*\]/,
  /\bidentical to (?:the )?previous\b/i,
  // Anchored to a stub-shaped subject: bare "from the previous" matches innocent comments like
  // `// Ported from the previous system`.
  /\b(?:same|copied|carried over|unchanged|reused?|taken|lifted|as) (?:\w+\s+){0,3}from the previous\b/i,
  /\b(?:code|logic|markup|styles?|body|rest|remainder|implementation) from the previous\b/i,
  /\bprevious (?:complete|working|full)\b/i,
  /\bfor brevity\b/i,
  // "omitted" and "unchanged" are qualified rather than bare: `// optional fields omitted from
  // the payload` and `// props unchanged, skip re-render` are ordinary comments in working
  // code, and a single match here returns HIGH confidence. Only the stub readings are matched.
  /\b(?:rest|remainder|others?|everything else|the code|logic|markup|styles?) (?:\w+\s+){0,2}omitted\b/i,
  /\bomitted (?:for|to save|here)\b/i,
  /\b(?:rest|remainder|everything else|all else|the code|logic|markup) (?:\w+\s+){0,2}unchanged\b/i,
  /\bunchanged from (?:the )?(?:previous|original|above|earlier)\b/i,
  /\brest of the\b/i,
  /<\s*rest of\b/i,
  /\bsame as (?:above|before)\b/i,
  /\b(?:code|implementation|logic|content) (?:goes )?here\b/i,
  /\bgoes here\b/i,
];
// Deliberately NOT patterns: "truncated" and "abbreviated" describe what plenty of real code
// legitimately does ("// label truncated to fit the column"), and they are high-confidence
// matches, so a single such comment would flag a working artifact.

/**
 * Identifiers that resolve without a declaration in the artifact sandbox: JS/DOM globals,
 * the blessed chart.js global, and the React APIs pre-injected into React artifacts (which
 * the artifact prompt explicitly tells the model NOT to import - so they are never declared).
 */
const AMBIENT_GLOBALS: ReadonlySet<string> = new Set([
  // Language
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Proxy',
  'Reflect',
  'Intl',
  'Function',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'structuredClone',
  'queueMicrotask',
  'require',
  'import',
  'super',
  // Timers + scheduling
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  // DOM / BOM
  'document',
  'window',
  'console',
  'navigator',
  'location',
  'history',
  'screen',
  'performance',
  'crypto',
  'localStorage',
  'sessionStorage',
  'alert',
  'confirm',
  'prompt',
  'fetch',
  'getComputedStyle',
  'matchMedia',
  'scrollTo',
  'open',
  'close',
  'print',
  'atob',
  'btoa',
  'Image',
  'Audio',
  'Blob',
  'File',
  'FileReader',
  'FormData',
  'URL',
  'URLSearchParams',
  // Typed arrays / buffers - routine in canvas and Web Audio artifacts and never declared
  // locally, so without these entries any two of them in one file would cross the
  // undefined-reference threshold on their own.
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'XMLHttpRequest',
  'WebSocket',
  'AbortController',
  'Response',
  'Request',
  'Headers',
  'TextEncoder',
  'TextDecoder',
  'Event',
  'CustomEvent',
  'DOMParser',
  'XMLSerializer',
  'Path2D',
  'IntersectionObserver',
  'ResizeObserver',
  'MutationObserver',
  'AudioContext',
  'webkitAudioContext',
  'OffscreenCanvas',
  'Worker',
  'Notification',
  // Blessed publish-time library global (see BLESSED_SCRIPT_PATHS)
  'Chart',
  // Pre-injected in React artifacts - never imported, never declared
  'React',
  'Fragment',
  'useState',
  'useEffect',
  'useRef',
  'useMemo',
  'useCallback',
  'useReducer',
  'useContext',
  'useLayoutEffect',
  'useId',
  'createContext',
  'createElement',
  'memo',
  'forwardRef',
]);

/** Control-flow keywords that a naive `name(` scan would otherwise read as calls. */
const CALL_LIKE_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'instanceof',
  'void',
  'delete',
  'await',
  'yield',
  'new',
  'function',
  'do',
  'else',
  'in',
  'of',
  'case',
  'with',
  'throw',
]);

/**
 * Artifact types whose body is (or contains) JavaScript we can reason about. The
 * declared-vs-called scan is JS-shaped, so it is NOT run on `code` artifacts: their language
 * is unknown at this layer and running it over Go or Rust would produce noise. Comment
 * scanning still applies to every type.
 */
const JS_BEARING_TYPES: ReadonlySet<string> = new Set(['html', 'react']);

/** Inline event-handler attributes scanned for calls into functions that were never defined. */
const HANDLER_ATTRIBUTE_REGEX = /\bon([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const SCRIPT_BLOCK_REGEX = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;

export function detectElidedContent(body: string, type?: ArtifactType): ElisionResult {
  const signals: ElisionSignal[] = [];
  if (!body || !body.trim()) return { elided: false, confidence: 'low', signals };

  signals.push(...findPlaceholderComments(body, type));

  if (type && JS_BEARING_TYPES.has(type)) {
    const js = type === 'react' ? [body] : extractScriptBodies(body);
    const declared = new Set<string>();
    const called = new Map<string, true>();

    // Stripped once and reused by every scan below - this is the expensive step on a large body.
    const strippedSources = js.map(stripCommentsAndStrings);

    for (const stripped of strippedSources) {
      collectDeclaredNames(stripped, declared);
      for (const name of collectCalledNames(stripped)) called.set(name, true);
    }

    // Belt-and-braces: a scanner desync (the string/comment stripper mis-tracking a nested
    // construct) can hide a real declaration and invent "undefined" names, which would flag a
    // perfectly good artifact. Re-check every candidate against the RAW source before
    // reporting it. Costs one regex per candidate and makes this class of bug non-fatal.
    const rawJs = js.join('\n');
    for (const name of called.keys()) {
      if (!declared.has(name) && !AMBIENT_GLOBALS.has(name) && !isDeclaredInRawSource(name, rawJs)) {
        signals.push({ kind: 'undefined_reference', name });
      }
    }

    // Hollowed-out functions: declared, called, and containing nothing but a comment. This is
    // the variant where the model keeps every skeleton and describes what the code WOULD do
    // ("// Render all UI components and attach event listeners"). Neither signal above sees it:
    // the comments are descriptive rather than referential, and every name resolves because the
    // declaration is still there. Only the missing bodies give it away.
    for (const name of collectCommentOnlyFunctions(strippedSources)) {
      signals.push({ kind: 'empty_function_body', name });
    }

    // HTML handler attributes live outside <script>, so they are scanned against the same
    // declared set - `onclick="renderBoard()"` with no renderBoard anywhere is the exact
    // shape an elided interactive page leaves behind.
    if (type === 'html') {
      for (const { attribute, name } of collectHandlerCalls(body)) {
        if (!declared.has(name) && !AMBIENT_GLOBALS.has(name) && !isDeclaredInRawSource(name, rawJs)) {
          signals.push({ kind: 'undefined_handler', name, attribute });
        }
      }
    }
  }

  const hasPlaceholder = signals.some(s => s.kind === 'placeholder_comment');
  const hollowCount = signals.filter(s => s.kind === 'empty_function_body').length;
  // Distinct names from the REFERENCE signals only. Hollow bodies are deliberately excluded:
  // pooling them here let two ordinary no-ops with different names reach the threshold on their
  // own, which contradicts the rule below and is a false positive on working code.
  const distinctMissingRefs = new Set(
    signals
      .filter(s => s.kind === 'undefined_reference' || s.kind === 'undefined_handler')
      .map(s => (s as { name: string }).name)
  ).size;

  // Three or more comment-only bodies is as unambiguous as a stub marker - an artifact does not
  // accidentally declare that many functions and implement none of them. One or two could be a
  // deliberate no-op, so on their own they never fire; they only corroborate a reference miss.
  const hollowIsConclusive = hollowCount >= HOLLOW_BODY_HIGH_CONFIDENCE;
  const confidence = hasPlaceholder || hollowIsConclusive ? 'high' : 'low';

  return {
    elided:
      hasPlaceholder || hollowIsConclusive || distinctMissingRefs >= 2 || (hollowCount > 0 && distinctMissingRefs > 0),
    confidence,
    signals,
  };
}

/** Comment-only function bodies needed before hollowness alone is conclusive. */
const HOLLOW_BODY_HIGH_CONFIDENCE = 3;

/**
 * Names of functions declared with a body containing nothing but comments. Takes ALREADY-STRIPPED
 * sources, in which comments are blank space, so a stub body reads as pure whitespace. Matches
 * only bodies with no nested braces, which is all a stub has - any real implementation
 * containing a block simply will not match, so this cannot fire on working code.
 */
function collectCommentOnlyFunctions(strippedSources: string[]): string[] {
  const hollow: string[] = [];
  for (const stripped of strippedSources) {
    const pattern = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stripped)) !== null) {
      if (m[2].trim() === '') hollow.push(m[1]);
    }
  }
  return hollow;
}

/**
 * Extracts comment text - and ONLY comment text - then matches the stub phrases against it.
 * `#` is treated as a comment marker for python artifacts alone; elsewhere it is a CSS colour
 * or a URL fragment. A `//` preceded by `:` is a URL scheme, not a comment.
 */
function findPlaceholderComments(body: string, type?: ArtifactType): ElisionSignal[] {
  const found: ElisionSignal[] = [];
  const lines = body.split('\n');
  let inBlockComment = false;
  let inHtmlComment = false;

  lines.forEach((line, index) => {
    const commentParts: string[] = [];
    let rest = line;

    // Continuations of a multi-line comment opened on an earlier line.
    if (inBlockComment) {
      const end = rest.indexOf('*/');
      if (end === -1) {
        commentParts.push(rest);
        rest = '';
      } else {
        commentParts.push(rest.slice(0, end));
        rest = rest.slice(end + 2);
        inBlockComment = false;
      }
    }
    if (inHtmlComment && rest) {
      const end = rest.indexOf('-->');
      if (end === -1) {
        commentParts.push(rest);
        rest = '';
      } else {
        commentParts.push(rest.slice(0, end));
        rest = rest.slice(end + 3);
        inHtmlComment = false;
      }
    }

    while (rest) {
      const block = rest.indexOf('/*');
      const html = rest.indexOf('<!--');
      const lineComment = findLineCommentStart(rest);
      const hash = type === 'python' ? findHashCommentStart(rest) : -1;
      const next = [block, html, lineComment, hash].filter(i => i !== -1).sort((a, b) => a - b)[0];
      if (next === undefined) break;

      if (next === lineComment || next === hash) {
        commentParts.push(rest.slice(next));
        rest = '';
      } else if (next === block) {
        const end = rest.indexOf('*/', next + 2);
        if (end === -1) {
          commentParts.push(rest.slice(next + 2));
          inBlockComment = true;
          rest = '';
        } else {
          commentParts.push(rest.slice(next + 2, end));
          rest = rest.slice(end + 2);
        }
      } else {
        const end = rest.indexOf('-->', next + 4);
        if (end === -1) {
          commentParts.push(rest.slice(next + 4));
          inHtmlComment = true;
          rest = '';
        } else {
          commentParts.push(rest.slice(next + 4, end));
          rest = rest.slice(end + 3);
        }
      }
    }

    for (const text of commentParts) {
      for (const pattern of PLACEHOLDER_PATTERNS) {
        const match = pattern.exec(text);
        if (match) {
          found.push({ kind: 'placeholder_comment', match: text.trim().slice(0, 200), line: index + 1 });
          return; // one signal per line is enough; keeps the payload small
        }
      }
    }
  });

  return found;
}

/**
 * Index of a `//` that starts a comment - skips `://` (URLs), `//` inside a quoted string, and a
 * protocol-relative URL (`//example.com/x`), which at column 0 has no preceding `:` to catch it.
 */
function findLineCommentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
      if (PROTOCOL_RELATIVE_URL_REGEX.test(line.slice(i))) continue;
      return i;
    }
  }
  return -1;
}

/**
 * A protocol-relative URL, e.g. `//cdn.example.com/lib.js`. Requires a dotted host immediately
 * after the slashes, which a real comment never has - `// example.com is down` has a space, and
 * `//TODO` has no dot.
 */
const PROTOCOL_RELATIVE_URL_REGEX = /^\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/:?#]|$)/;

/** Index of a python `#` comment marker outside any quoted string. */
function findHashCommentStart(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return i;
  }
  return -1;
}

function extractScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  SCRIPT_BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK_REGEX.exec(html)) !== null) {
    if (match[1].trim()) bodies.push(match[1]);
  }
  return bodies;
}

/**
 * Blanks out comments and string/template literals so the identifier scans below never see
 * code-shaped text inside data. Regex literals are recognised by the usual "what preceded it"
 * heuristic - a `/` after an operator or opener starts a regex, a `/` after a value is division.
 * Replaces with spaces rather than deleting so nothing is falsely joined across the gap.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  let prevMeaningful = '';
  /**
   * Nested template-literal contexts, innermost last. Each entry is the `{` nesting depth
   * within the current `${ ... }` interpolation, or TEMPLATE_TEXT while in the literal's
   * text. A stack is required because an interpolation can contain another template literal.
   */
  const templates: number[] = [];
  const inTemplateText = () => templates.length > 0 && templates[templates.length - 1] === TEMPLATE_TEXT;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    // Template TEXT is data: blank it, but watch for `${` (code resumes) and the closing
    // backtick. Interpolation bodies fall through to the normal code handling below.
    if (inTemplateText()) {
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '`') {
        templates.pop();
        out += ' ';
        i++;
        prevMeaningful = 'x';
        continue;
      }
      if (ch === '$' && next === '{') {
        templates[templates.length - 1] = 0;
        out += '  ';
        i += 2;
        prevMeaningful = '{';
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    // Inside an interpolation, braces decide when template text resumes.
    if (templates.length > 0 && templates[templates.length - 1] >= 0) {
      if (ch === '{') {
        templates[templates.length - 1]++;
      } else if (ch === '}') {
        if (templates[templates.length - 1] === 0) {
          templates[templates.length - 1] = TEMPLATE_TEXT;
          out += ' ';
          i++;
          continue;
        }
        templates[templates.length - 1]--;
      }
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += ' ';
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      prevMeaningful = 'x'; // a string is a value: a following `/` is division
      continue;
    }
    if (ch === '`') {
      // Enter template text. Handled via the stack below rather than "consume to the next
      // backtick", which breaks on a nested template inside `${...}` - the inner backtick
      // reads as the outer terminator and every later declaration looks string-quoted.
      templates.push(TEMPLATE_TEXT);
      out += ' ';
      i++;
      continue;
    }
    if (ch === '/' && startsRegexLiteral(prevMeaningful)) {
      out += ' ';
      i++;
      while (i < source.length && source[i] !== '/' && source[i] !== '\n') {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === '[') {
          // Skip a character class so an unescaped `/` inside it does not end the literal.
          while (i < source.length && source[i] !== ']' && source[i] !== '\n') {
            out += ' ';
            i++;
          }
        }
        out += ' ';
        i++;
      }
      out += ' ';
      i++;
      prevMeaningful = 'x';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) prevMeaningful = ch;
    i++;
  }

  return out;
}

/** Stack sentinel: we are in a template literal's text, not inside a `${ ... }` interpolation. */
const TEMPLATE_TEXT = -1;

/** A `/` in these positions opens a regex literal rather than dividing. */
function startsRegexLiteral(prevMeaningful: string): boolean {
  if (!prevMeaningful) return true;
  return '(,=:[!&|?{};+-*%<>~^'.includes(prevMeaningful);
}

const DECLARATION_PATTERNS: readonly RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  // Assignment to a bare or namespaced name: `run = function`, `window.run = () =>`
  /(?:^|[\s;{}])(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\()/gm,
  // Object-literal / class method shorthand: `render() {`
  /(?:^|[\s;{,])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g,
  // import default / namespace
  /\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\b/g,
];

/** Names bound by destructuring, imports-with-braces, and parameter lists. */
const BINDING_GROUP_PATTERNS: readonly RegExp[] = [
  /\b(?:const|let|var)\s*\{([^}]*)\}/g,
  /\b(?:const|let|var)\s*\[([^\]]*)\]/g,
  /\bimport\s*\{([^}]*)\}/g,
  /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
  /\bcatch\s*\(([^)]*)\)/g,
  // Arrow parameter lists: `(a, b) =>` and the bare `a =>` form
  /\(([^()]*)\)\s*=>/g,
  /(?:^|[\s;{(,])([A-Za-z_$][\w$]*)\s*=>/g,
];

function collectDeclaredNames(source: string, into: Set<string>): void {
  for (const pattern of DECLARATION_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      if (m[1] && !CALL_LIKE_KEYWORDS.has(m[1])) into.add(m[1]);
    }
  }
  for (const pattern of BINDING_GROUP_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) {
      harvestBoundNames(m[1] ?? '', into);
    }
  }
}

/**
 * Adds every identifier that a binding group BINDS, given the group's inner text.
 *
 * Harvests identifiers directly rather than splitting on commas, because a comma split cannot see
 * into nesting: `const { user: { name, email } }` captures `user: { name, email` and the old
 * split produced the fragment `user: { name`, losing `name` entirely. Anything followed by `:` is
 * a property KEY, not a binding, so it is skipped - which leaves the bound names at every depth.
 *
 * Deliberately over-inclusive: a default value (`{ a = fallback }`) contributes `fallback` too.
 * That direction is safe here - a name wrongly believed to be declared costs one missed detection,
 * whereas a name wrongly believed missing would flag a working artifact.
 */
function harvestBoundNames(groupText: string, into: Set<string>): void {
  const IDENT = /([A-Za-z_$][\w$]*)\s*(:)?/g;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(groupText)) !== null) {
    if (m[2]) continue; // property key, e.g. the `user` in `{ user: { name } }`
    if (!CALL_LIKE_KEYWORDS.has(m[1])) into.add(m[1]);
  }
}

/**
 * Characters of context inspected before a call site. Must stay well clear of the longest
 * thing the checks below look for (`function *` plus surrounding whitespace); a fixed window
 * keeps this O(1) per match. Slicing from index 0 instead would make the whole scan O(n^2),
 * which on a large artifact body means hundreds of MB of string churn and a frozen render.
 */
const CALL_LOOKBACK_CHARS = 64;

/**
 * Whether `name` is declared anywhere in the raw (un-stripped) source. A guard against a
 * stripper desync producing phantom "undefined" names, nothing more. Deliberately loose - it
 * matches a declaration even inside a comment or string, because a false "it exists" costs one
 * missed detection while a false "it is missing" wrongly flags a complete artifact.
 */
function isDeclaredInRawSource(name: string, source: string): boolean {
  const escaped = name.replace(/\$/g, '\\$');
  return new RegExp(
    `(?:function\\s*\\*?\\s*|class\\s+|const\\s+|let\\s+|var\\s+)${escaped}\\b` +
      `|\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\()` +
      `|\\b${escaped}\\s*\\([^()]*\\)\\s*\\{`
  ).test(source);
}

/** Bare-identifier call sites. Member calls (`obj.run()`) are excluded - we cannot resolve them. */
function collectCalledNames(source: string): Set<string> {
  const names = new Set<string>();
  const CALL_REGEX = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL_REGEX.exec(source)) !== null) {
    const name = m[1];
    if (CALL_LIKE_KEYWORDS.has(name) || names.has(name)) continue;
    const before = source.slice(Math.max(0, m.index - CALL_LOOKBACK_CHARS), m.index).replace(/\s+$/, '');
    if (before.endsWith('.') || before.endsWith('?.')) continue; // member call
    if (/\b(?:function|class)\s*\*?\s*$/.test(before)) continue; // declaration, not a call
    names.add(name);
  }
  return names;
}

function collectHandlerCalls(html: string): Array<{ attribute: string; name: string }> {
  const found: Array<{ attribute: string; name: string }> = [];
  HANDLER_ATTRIBUTE_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HANDLER_ATTRIBUTE_REGEX.exec(html)) !== null) {
    const attribute = `on${m[1].toLowerCase()}`;
    const code = m[2] ?? m[3] ?? '';
    for (const name of collectCalledNames(code)) {
      found.push({ attribute, name });
    }
  }
  return found;
}

/** Exposed for tests - not part of the runtime contract. */
export const __testing = { PLACEHOLDER_PATTERNS, AMBIENT_GLOBALS, JS_BEARING_TYPES };
