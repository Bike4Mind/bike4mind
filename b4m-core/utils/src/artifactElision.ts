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
 *
 * MUST STAY IN SYNC with the NEVER ABBREVIATE paragraph of `ARTIFACT_EMISSION_PROMPT` in
 * `@bike4mind/common` (`schemas/settings.ts`), which forbids the model from emitting these same
 * phrases. Neither side imports the other - the prompt is prose for a model, these are regexes -
 * so the coupling is by convention only, and the prompt is additionally live-editable per
 * environment, meaning drift cannot be caught at build time. Change both in one commit.
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
  // Qualified like its `omitted`/`unchanged` siblings. Bare `rest of the` was the one unqualified
  // phrase in the list and fired HIGH on ordinary comments such as
  // `// handle the rest of the items in the queue`.
  /\brest of the (?:\w+\s+){0,2}(?:code|logic|markup|styles?|implementation|functions?|handlers?|rows?|items?|entries|sections?|content|body|file|script|html|css|js)\b[^\n]{0,40}\b(?:omitted|unchanged|elided|removed|truncated|abbreviated|goes here|is identical|as (?:above|before)|same)\b/i,
  /\b(?:the )?rest of the (?:code|logic|markup|styles?|implementation|file|script|html|css|js)\b\s*(?:$|[.)\]}])/i,
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

  // An off-site <script src> defines globals this module cannot possibly know, so every bare call
  // into them looks undefined. A working jQuery page reaches the 2-distinct-name threshold on `$`
  // and `jQuery` alone, and a p5.js sketch flags on four. The reference signals are therefore
  // SUPPRESSED - not merely raised - when such a script is present: with an unknown global namespace
  // in play the signal carries no information, and a higher threshold would only postpone the same
  // false positive to a slightly larger sketch. Placeholder comments and hollow bodies are
  // unaffected, so the high-confidence signals still work on these artifacts.
  const referencesAreKnowable = !hasOffsiteScript(body);

  if (type && JS_BEARING_TYPES.has(type)) {
    const js = type === 'react' ? [body] : extractScriptBodies(body);
    const declared = new Set<string>();
    const called = new Map<string, true>();

    // Stripped once and reused by every scan below - this is the expensive step on a large body.
    const strippedSources = js.map(source => stripCommentsAndStrings(source));

    for (const stripped of strippedSources) {
      collectDeclaredNames(stripped, declared);
      for (const name of collectCalledNames(stripped)) called.set(name, true);
    }

    // Belt-and-braces: a scanner desync (the string/comment stripper mis-tracking a nested
    // construct) can hide a real declaration and invent "undefined" names, which would flag a
    // perfectly good artifact. So every candidate is re-checked against the RAW source.
    //
    // Harvested in ONE pass rather than a regex per candidate. The per-candidate form was
    // O(names x body) and measured 10s on a 380KB artifact with ~30k names - synchronous on the
    // completion worker AND on the publish click. This is deliberately LOOSE, matching declarations
    // even inside comments or strings: a false "it exists" costs one missed detection, a false
    // "it is missing" wrongly flags a working artifact.
    const rawDeclared = new Set<string>();
    collectDeclaredNames(js.join('\n'), rawDeclared);

    for (const name of referencesAreKnowable ? called.keys() : []) {
      if (!declared.has(name) && !AMBIENT_GLOBALS.has(name) && !rawDeclared.has(name)) {
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
    if (type === 'html' && referencesAreKnowable) {
      for (const { attribute, name } of collectHandlerCalls(body)) {
        if (!declared.has(name) && !AMBIENT_GLOBALS.has(name) && !rawDeclared.has(name)) {
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
 *
 * All three declaration forms are covered. The `function` keyword alone was not enough: react
 * artifacts overwhelmingly use `const handleX = () => {}`, so a react artifact with every handler
 * hollowed out - this detector's whole reason for existing, in the framework it most often has to
 * work in - produced zero signals.
 */
function collectCommentOnlyFunctions(strippedSources: string[]): string[] {
  // A SET, not a list: the same hollow function matches several patterns below (`function foo() {}`
  // matches both the declaration form and the method-shorthand form), and counting it twice would
  // walk an artifact toward HOLLOW_BODY_HIGH_CONFIDENCE on half the evidence.
  const hollow = new Set<string>();
  for (const stripped of strippedSources) {
    for (const pattern of HOLLOW_BODY_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(stripped)) !== null) {
        if ((m[2] ?? '').trim() !== '') continue;
        // `if (x) { }` and `catch (e) { }` are shaped exactly like method shorthand.
        if (CALL_LIKE_KEYWORDS.has(m[1]) || NEVER_HOLLOW_NAMES.has(m[1])) continue;
        hollow.add(m[1]);
      }
    }
  }
  return [...hollow];
}

/** Names whose empty body is ordinary rather than a stub. */
const NEVER_HOLLOW_NAMES: ReadonlySet<string> = new Set(['constructor', 'try', 'finally', 'else']);

/**
 * Declaration forms whose body can be checked for hollowness. Each captures the NAME in group 1 and
 * the BODY in group 2, and each body pattern is `[^{}]*` so a nested block disqualifies the match -
 * that is what keeps this from firing on real implementations.
 */
const HOLLOW_BODY_PATTERNS: readonly RegExp[] = [
  // function declarations and named function expressions
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{([^{}]*)\}/g,
  // arrow assigned to a binding: `const handleClick = () => {}`, `let f = async (a) => {}`
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{([^{}]*)\}/g,
  // arrow assigned to an existing or namespaced binding: `window.render = () => {}`
  /(?:^|[\s;{}])(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{([^{}]*)\}/gm,
  // object-literal / class method shorthand: `render() {}`, `async load() {}`
  /(?:^|[\s;{,])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{([^{}]*)\}/gm,
];

/**
 * Extracts comment text - and ONLY comment text - then matches the stub phrases against it.
 * `#` is treated as a comment marker for python artifacts alone; elsewhere it is a CSS colour
 * or a URL fragment. A `//` preceded by `:` is a URL scheme, not a comment.
 */
function findPlaceholderComments(body: string, type?: ArtifactType): ElisionSignal[] {
  const found: ElisionSignal[] = [];
  const seenLines = new Set<number>();

  for (const comment of collectComments(body, type)) {
    const line = indexToLine(body, comment.start);
    if (seenLines.has(line)) continue; // one signal per line is enough; keeps the payload small
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(comment.text)) {
        seenLines.add(line);
        found.push({ kind: 'placeholder_comment', match: comment.text.trim().slice(0, 200), line });
        break;
      }
    }
  }

  return found.sort((a, b) => (a as { line: number }).line - (b as { line: number }).line);
}

/** A comment as located in the original body. `start` indexes the opening delimiter. */
interface RawCommentSpan {
  start: number;
  text: string;
}

/**
 * Every comment in the body, lexed by the rules of the language it is actually written in.
 *
 * Dispatching on type matters: in HTML, `//` is not a comment and a quote is either attribute
 * syntax or ordinary apostrophe-bearing prose, while inside `<script>` the JS rules apply and `<!--`
 * means nothing. Lexing one with the other's rules is what produced high-confidence false positives
 * on artifacts that merely displayed sample code or assembled markup in a template literal.
 */
function collectComments(body: string, type?: ArtifactType): RawCommentSpan[] {
  if (type === 'python') return collectHashComments(body);
  if (type === 'html') return collectHtmlComments(body);

  // react / code / unknown: JS rules. The HTML sweep runs over the STRIPPED output, where every
  // string, template and comment is already blanked, so `<!--` can only be found in live markup
  // (a `code` artifact holding an HTML document) and never inside JS data.
  const spans: RawCommentSpan[] = [];
  const stripped = stripCommentsAndStrings(body, spans);
  spans.push(...collectHtmlCommentDelimited(stripped, body, 0));
  return spans;
}

/**
 * HTML comments in a markup region, read from `scanIn` but with text taken from `textFrom` at the
 * same offsets (so a blanked stripper output can locate them while the real text is reported).
 */
function collectHtmlCommentDelimited(scanIn: string, textFrom: string, offset: number): RawCommentSpan[] {
  const spans: RawCommentSpan[] = [];
  let from = 0;
  for (;;) {
    const open = scanIn.indexOf('<!--', from);
    if (open === -1) break;
    const close = scanIn.indexOf('-->', open + 4);
    const end = close === -1 ? scanIn.length : close;
    spans.push({ start: offset + open, text: textFrom.slice(open + 4, end) });
    if (close === -1) break;
    from = close + 3;
  }
  return spans;
}

/**
 * Walks an HTML document, applying the right comment rules per region: `<!-- -->` in markup,
 * JS rules inside `<script>`, and `/* *\/` inside `<style>`. Attribute values are skipped so a
 * quoted `//` or `<!--` inside one cannot register.
 */
function collectHtmlComments(html: string): RawCommentSpan[] {
  const spans: RawCommentSpan[] = [];
  let i = 0;

  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      const end = close === -1 ? html.length : close;
      spans.push({ start: i, text: html.slice(i + 4, end) });
      if (close === -1) break;
      i = close + 3;
      continue;
    }

    const embedded = /^<(script|style)\b/i.exec(html.slice(i));
    if (embedded) {
      const tagName = embedded[1].toLowerCase();
      const openEnd = html.indexOf('>', i);
      if (openEnd === -1) break;
      const closeTag = new RegExp(`</${tagName}\\s*>`, 'i').exec(html.slice(openEnd + 1));
      const bodyStart = openEnd + 1;
      const bodyEnd = closeTag ? bodyStart + closeTag.index : html.length;
      const inner = html.slice(bodyStart, bodyEnd);

      if (tagName === 'script') {
        const innerSpans: RawCommentSpan[] = [];
        stripCommentsAndStrings(inner, innerSpans);
        for (const s of innerSpans) spans.push({ start: bodyStart + s.start, text: s.text });
      } else {
        for (const s of collectCssComments(inner)) spans.push({ start: bodyStart + s.start, text: s.text });
      }

      i = closeTag ? bodyEnd + closeTag[0].length : html.length;
      continue;
    }

    if (html[i] === '<') {
      i = skipHtmlTag(html, i);
      continue;
    }

    i++;
  }

  return spans;
}

/** Index just past the tag starting at `open`, skipping quoted attribute values. */
function skipHtmlTag(html: string, open: number): number {
  let i = open + 1;
  let quote: string | null = null;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
    i++;
  }
  return html.length;
}

/** `/* *\/` comments in CSS. No line comments, no templates - strings only. */
function collectCssComments(css: string): RawCommentSpan[] {
  const spans: RawCommentSpan[] = [];
  let i = 0;
  let quote: string | null = null;
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const end = close === -1 ? css.length : close;
      spans.push({ start: i, text: css.slice(i + 2, end) });
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    i++;
  }
  return spans;
}

/** 1-based line number for a byte offset. */
function indexToLine(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

// A protocol-relative-URL pattern used to live here, to stop `<script src="//cdn.example.com/x">`
// being read as a line comment. It is gone because the cause is gone: HTML is now walked
// tag-aware (see skipHtmlTag), so an attribute value is never scanned for comments in the first
// place, and inside a <script> body a bare `//host/path` line IS a JS line comment - reading it as
// one is correct, not a workaround. Both behaviours stay pinned by tests.

/**
 * Python `#` comments, skipping quoted strings including triple-quoted blocks (a docstring
 * containing `#` or a stub phrase must not register - docstrings are prose by definition).
 */
function collectHashComments(source: string): RawCommentSpan[] {
  const spans: RawCommentSpan[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === '"' || ch === "'") {
      const triple = source.startsWith(ch.repeat(3), i);
      const delimiter = triple ? ch.repeat(3) : ch;
      i += delimiter.length;
      while (i < source.length && !source.startsWith(delimiter, i)) {
        i += source[i] === '\\' ? 2 : 1;
      }
      i += delimiter.length;
      continue;
    }

    if (ch === '#') {
      const newline = source.indexOf('\n', i);
      const end = newline === -1 ? source.length : newline;
      spans.push({ start: i, text: source.slice(i + 1, end) });
      i = end;
      continue;
    }

    i++;
  }
  return spans;
}

/**
 * Whether the body loads a script from another origin - `https://`, `http://`, or protocol-relative
 * `//host/`. Root-relative sources are deliberately NOT counted: those are the self-hosted blessed
 * libraries whose globals are already listed in AMBIENT_GLOBALS, so they remain knowable.
 *
 * Matched by attribute rather than by importing the blessed-path list, which lives in the
 * `@bike4mind/common` barrel - and pulling the barrel in would defeat the point of this module
 * having its own dependency-free subpath entry.
 */
function hasOffsiteScript(html: string): boolean {
  OFFSITE_SCRIPT_REGEX.lastIndex = 0;
  return OFFSITE_SCRIPT_REGEX.test(html);
}

const OFFSITE_SCRIPT_REGEX = /<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i;

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
 * heuristic - a `/` after an operator, opener, or value-less keyword starts a regex, a `/` after a
 * value is division. Replaces with spaces rather than deleting so nothing is falsely joined across
 * the gap, which also makes the output POSITION-IDENTICAL to the input - `collectInto` spans are
 * therefore valid indices into the original source.
 *
 * Pass `collectInto` to also harvest every comment this pass identifies. That is the ONLY supported
 * way to find comments in JS: the placeholder scan used to re-lex the raw body with a weaker
 * line-by-line matcher that had no string or template state, so an artifact merely DISPLAYING
 * `/* for brevity *\/` inside a string flagged at high confidence.
 */
function stripCommentsAndStrings(source: string, collectInto?: RawCommentSpan[]): string {
  let out = '';
  let i = 0;
  let prevMeaningful = '';
  /** Preceding identifier/keyword run, needed because `return /re/` is a regex, not division. */
  let prevWord = '';
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
      const start = i;
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      collectInto?.push({ start, text: source.slice(start + 2, i) });
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      out += '  ';
      i += 2;
      const textStart = i;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      collectInto?.push({ start, text: source.slice(textStart, i) });
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
    if (ch === '/' && startsRegexLiteral(prevMeaningful, prevWord)) {
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
    // Accumulate the current identifier run so a keyword before `/` can be recognised.
    if (/[A-Za-z_$]/.test(ch) || (prevWord && /[\w$]/.test(ch))) prevWord += ch;
    else if (!/\s/.test(ch)) prevWord = '';
    i++;
  }

  return out;
}

/** Stack sentinel: we are in a template literal's text, not inside a `${ ... }` interpolation. */
const TEMPLATE_TEXT = -1;

/**
 * Keywords after which a `/` opens a regex literal, because none of them evaluates to a value that
 * could be divided. Without these, `return /\d+/.test(x)` lexed as division and the "regex" body
 * stayed live code, leaking phantom identifiers into the undefined-reference scan.
 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'delete',
  'void',
  'throw',
  'new',
  'do',
  'else',
  'yield',
  'await',
]);

/** A `/` in these positions opens a regex literal rather than dividing. */
function startsRegexLiteral(prevMeaningful: string, prevWord = ''): boolean {
  if (!prevMeaningful) return true;
  if (REGEX_PRECEDING_KEYWORDS.has(prevWord)) return true;
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
  // Property assigned a function: `render: function () {}`, `render: () => {}`. Over-inclusive by
  // design (a ternary's `: fn(` also matches) - over-inclusive means a missed detection, never a
  // false positive on working code.
  /(?:^|[\s;{,])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\b|\()/g,
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

// The raw-source declaration guard used to be a per-candidate `isDeclaredInRawSource(name, source)`
// that compiled a RegExp and rescanned the whole body for every candidate - O(names x body). It is
// now one `collectDeclaredNames` pass over the raw source at the call site, membership-tested per
// candidate. Same looseness, same purpose, without the quadratic blow-up on a large artifact.

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
    // `new Person()` names a constructor, and an undeclared one is far more likely to be an
    // ambient class we simply do not list than an elided body - a class that WAS elided keeps its
    // `class X {` declaration. Skipping it trades a missed detection for no false positive.
    if (/\bnew$/.test(before)) continue;
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
