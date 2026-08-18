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
 *  - Hollow function bodies - declared, called, and containing nothing but a comment. Only bodies
 *    whose comment DESCRIBES missing behaviour count (a deliberate no-op declares itself, and is
 *    excluded): two report, three or more report high confidence. One only corroborates.
 *
 * ADVISORY ONLY. Callers must never drop, rewrite, or block content on this result - unlike
 * the truncation path, which force-closes a dangling tag. A false positive here is a slightly
 * wrong warning; a false positive that ate a good artifact would be a worse bug than the one
 * this module exists to catch.
 *
 * `confidence` is DIAGNOSTIC ONLY - no consumer gates on it, so 'high' and 'low' produce the same
 * user-visible affordance. Do not read a graduated response into it.
 */

export type ElisionSignal =
  | { kind: 'placeholder_comment'; match: string; line: number }
  | { kind: 'undefined_reference'; name: string }
  | { kind: 'undefined_handler'; name: string; attribute: string }
  | { kind: 'empty_function_body'; name: string };

export interface ElisionResult {
  /** Crossed the reporting threshold - show an advisory "may be incomplete" affordance. */
  elided: boolean;
  /**
   * 'high' for a placeholder comment or 3+ described hollow bodies; everything else 'low'.
   * DIAGNOSTIC ONLY - no caller gates on this today, so both levels produce the same user-visible
   * affordance. See the note at the threshold computation.
   */
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
  // `// Ported from the previous system`. The prompt forbids the bare phrase "from the previous
  // version", so this is a KNOWN, deliberate asymmetry - the qualifier is what keeps the innocent
  // reading out, and `version` is included below so the prompt's exact wording is still covered.
  /\b(?:same|copied|carried over|unchanged|reused?|taken|lifted|as) (?:\w+\s+){0,3}from the previous\b/i,
  /\b(?:code|logic|markup|styles?|body|rest|remainder|implementation) from the previous\b/i,
  /\bfrom the previous (?:complete|full|working) (?:version|artifact|response|turn|message)\b/i,
  // Not in the prompt's forbidden list, kept because they are unambiguous stub markers in a comment.
  // Flagging a phrase the prompt never warned against is the safe direction of this drift: the model
  // is not being punished for following instructions, and a reader gets a warning either way.
  /\bprevious (?:complete|working|full)\b/i,
  // Adjacency-anchored `for brevity` matched the bare form and nothing else, so an interpolated
  // variant ("for the sake of brevity", "in the interest of brevity") walked straight past it while
  // its own sibling `TRUNCATED ... FOR BREVITY` matched - one phrasing of the same marker detected
  // and the other not. The connectives are ENUMERATED rather than a free filler window: a
  // `(?:\w+\s+){0,4}` window also swallowed `// penalize the score for excessive brevity in the
  // answer`, where brevity is the subject matter rather than an excuse for omitting code.
  // Whitespace after the preposition is still required, so `for-brevity-notes.js` stays unmatched.
  /\b(?:for|in) (?:the (?:sake|interests?|purposes?) of |reasons of )?brevity\b/i,
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
  // A continuation instruction addressed to the reader. Chat scaffolding that leaked into the
  // artifact body has no innocent reading in a finished deliverable - the artifact is a standalone
  // document, so there is no "next response" for it to be continued in, and nothing inside it can
  // ask the user to reply. Observed verbatim in a shipped artifact that published with no warning.
  //
  // The quote wrapper is REQUIRED, or an explicit "please". Without one of those, this fired on
  // ordinary control-flow prose: `// if they say continue, restart the loop` and
  // `// users can reply continue to resume` are both about the artifact's OWN behaviour, not about
  // the reader. A model asking for continuation quotes or shouts the token.
  /\b(?:respond|reply|answer|say|type) (?:with )?["'`*]{1,2}continue\b/i,
  /\bplease (?:respond|reply|answer) (?:with )?continue\b/i,
  // Deliberately WITHOUT the `i` flag: an unquoted but shouted CONTINUE is the commonest form of
  // this instruction and the quote requirement above misses it, while every false-positive reading
  // spells it lowercase (`if they say continue`, `users can reply continue to resume`). The case of
  // CONTINUE is the whole discriminator, so do not add `i` here - the VERB is spelled both ways
  // because it may open a sentence, and only the token needs to be shouted.
  /\b(?:[Rr]espond|[Rr]eply|[Aa]nswer|[Tt]ype) (?:with )?CONTINUE\b/,
  // `next response` needs no qualifier. `next message|reply|turn` DOES: bare, it fired on
  // `// clicking advances the carousel so users see the next message`, an ordinary UI comment. Two
  // qualified forms have no such reading - an authorial "continued in", or a remainder named right
  // after. `in` is not an alternative to `see` either, since `// in the next response we get the
  // cursor` is ordinary pagination.
  /\b(?:see|continued? in|continues in) (?:the )?next response\b/i,
  /\bcontinued? in (?:the )?next (?:message|reply|turn)\b/i,
  /\b(?:see|in) (?:the )?next (?:message|reply|turn)\b[^\n]{0,40}\b(?:rest|remaining|remainder|continuation)\b/i,
  // Omission behind a count. First person in artifact source is the giveaway: shipped code never
  // promises what its author is about to write. The trailing object must be a COUNTED or PLURAL
  // body of content, which is what separates "deferred delivery of the artifact's own content" from
  // an ordinary prose TODO. A bare number or a bare `remaining` is not enough - those fired on
  // `// I will add 2 more validation rules below` and `// I will add the remaining validation later`,
  // the second of which also contradicted this comment's own claim that prose TODOs stay clean.
  // `the rest` is exempt from the counted-or-plural requirement, because with no noun after it the
  // phrase can only mean the artifact's own remaining content - which is the admission we want.
  // The rule exists to exclude a promise about a NAMED feature (`the remaining validation later`),
  // and that still needs the count or plural.
  /\bI(?: will| shall|'ll| am going to) (?:now |then |immediately )?(?:include|add|send|provide|write|emit|list|continue)\b[^\n]{0,30}\b(?:the )?(?:(?:remaining|rest of the|other|further|additional)\s+(?:\d+\s+[\w-]+|[\w-]+s)|rest(?:\s+of\s+(?:the|them|it))?)\b/i,
  // `all individually|each` is REQUIRED, as the real specimen carried it. Without it the truthful
  // reading is lexically identical to the lying one: `// The following 4 helpers are all defined
  // below` describes working code, and fired at HIGH confidence.
  /\b(?:following|remaining) \d+ [\w-]+ (?:are|will be) (?:all (?:individually |each )|individually |each )(?:defined|included|listed|written|implemented|present)\b/i,
];
// Deliberately NOT patterns, all for the same reason - a single match here returns HIGH confidence,
// so a phrase that reads innocently in working code would flag a complete artifact:
//  - "truncated" and "abbreviated", which plenty of real code legitimately does
//    ("// label truncated to fit the column").
//  - a bare `N further items`-style count ("// the remaining 3 bytes are padding"). The elided
//    artifact that motivated the count patterns above carried all three of its phrasings, so it
//    still flags on the two that ARE matched.
//  - a comment whose whole text is `...`. Plausibly a stub marker, but the pattern would be broad
//    enough to deserve its own decision rather than riding along with these.

/**
 * Identifiers that resolve without a declaration in the artifact sandbox: JS/DOM globals,
 * the blessed chart.js global, and the React APIs pre-injected into React artifacts (which
 * the artifact prompt explicitly tells the model NOT to import - so they are never declared).
 *
 * MUST STAY IN SYNC with what the sandbox actually pre-injects, and with the REACT ARTIFACTS
 * paragraph of `ARTIFACT_EMISSION_PROMPT` (`@bike4mind/common`, `schemas/settings.ts`) that lists
 * those globals to the model. This list is HAND-MAINTAINED, not derived from the runtime, so adding a
 * pre-injected API or a blessed library global there without adding it here makes every artifact that
 * uses it look like it calls something undefined. Fail-safe in the sense that the reference signals
 * are low-confidence and need two distinct names - but two new React hooks would be enough.
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
  /** Hollow bodies whose comment describes missing behaviour - see describesMissingBehaviour. */
  let describedHollowCount = 0;

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
    for (const body of collectCommentOnlyFunctions(strippedSources, js)) {
      signals.push({ kind: 'empty_function_body', name: body.name });
      if (describesMissingBehaviour(body.comment)) describedHollowCount++;
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

  // Only DESCRIBED hollow bodies count toward these thresholds. A body that declares itself
  // deliberate (`// intentionally does nothing`) is excluded, which is what lets both of the
  // conflicting requirements hold at once: two ordinary no-ops stay silent, while two bodies that
  // describe behaviour they do not implement are reported. QA reproduced the latter twice - a task
  // board rendering empty columns while its counter truthfully read "5 of 5 tasks shown".
  //
  // Three or more is as unambiguous as a stub marker, so it reports HIGH; two reports LOW.
  //
  // Be clear about what that does NOT buy: `confidence` is DIAGNOSTIC ONLY. Nothing gates on it -
  // the banner and the publish gate both read `elided`, and the server verdict reduces to a boolean -
  // so HIGH and LOW are indistinguishable to a user, and the cost of a false positive at either level
  // is the full banner plus the publish checkbox. It is persisted for the debug inspector and for
  // whoever tunes these thresholds next. If a softer treatment for LOW is ever wanted, that is a
  // deliberate change at the two consumers, not something this value already delivers.
  const hollowIsConclusive = describedHollowCount >= HOLLOW_BODY_HIGH_CONFIDENCE;
  const hollowIsReportable = describedHollowCount >= HOLLOW_BODY_REPORTABLE;
  const confidence = hasPlaceholder || hollowIsConclusive ? 'high' : 'low';

  return {
    elided:
      hasPlaceholder ||
      hollowIsConclusive ||
      hollowIsReportable ||
      distinctMissingRefs >= 2 ||
      (hollowCount > 0 && distinctMissingRefs > 0),
    confidence,
    signals,
  };
}

/** Described-behaviour hollow bodies needed before hollowness alone reports HIGH confidence. */
const HOLLOW_BODY_HIGH_CONFIDENCE = 3;

/**
 * Described-behaviour hollow bodies needed to report at all. Two functions that each describe work
 * they do not do is not a plausible accident, and it is the shape QA caught escaping: an artifact
 * that renders, exposes controls, and silently does nothing. Below this, hollowness only corroborates
 * a reference miss.
 */
const HOLLOW_BODY_REPORTABLE = 2;

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
function collectCommentOnlyFunctions(strippedSources: string[], rawSources: string[]): HollowBody[] {
  // Keyed by BODY POSITION, not by name. The same hollow function matches several patterns below
  // (`function foo() {}` matches both the declaration and the method-shorthand form) and counting it
  // twice would walk an artifact toward the threshold on half the evidence - but every pattern resolves
  // the same body to the same offset, so position dedupes those while keeping genuinely distinct
  // functions apart. Keying on the name instead collapsed `a.onclick` and `b.onclick` into one entry,
  // which is the commonest handler shape there is.
  const hollow = new Map<string, { name: string; comment: string }>();
  strippedSources.forEach((stripped, index) => {
    const raw = rawSources[index] ?? '';
    for (const pattern of HOLLOW_BODY_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(stripped)) !== null) {
        if ((m[2] ?? '').trim() !== '') continue;
        // `if (x) { }` and `catch (e) { }` are shaped exactly like method shorthand.
        if (CALL_LIKE_KEYWORDS.has(m[1]) || NEVER_HOLLOW_NAMES.has(m[1])) continue;
        // The body is blank in the stripped source because SOMETHING there was blanked - usually a
        // comment, but a lone string or regex literal blanks the same way, so `function a() { /re/ }`
        // reads as hollow and feeds the regex text to describesMissingBehaviour. Contrived enough to
        // accept: it needs two such bodies and text that names a behaviour verb.
        //
        // The comment text comes from the raw source at the SAME offsets. The stripper replaces rather
        // than deletes, so its output aligns with its input at every offset inside the input; it can
        // overshoot by a character or two past the end of an unterminated construct at EOF, which is
        // beyond any offset used here.
        const bodyStart = m.index + m[0].lastIndexOf('{') + 1;
        const comment = raw.slice(bodyStart, bodyStart + (m[2] ?? '').length);
        const key = `${index}:${bodyStart}`;
        if (!hollow.has(key)) hollow.set(key, { name: m[1], comment });
      }
    }
  });
  return [...hollow.values()];
}

/** A function whose body is nothing but a comment, with that comment's raw text. */
interface HollowBody {
  name: string;
  comment: string;
}

/**
 * Verbs that name WORK a function body would do. Positive evidence that a comment is standing in for
 * an implementation rather than explaining an intentional absence.
 *
 * The direction of this list matters, and it is the opposite of a no-op whitelist. An earlier version
 * defined "describes behaviour" as "does not match a short list of no-op phrasings", which meant every
 * phrasing missing from that list became a false positive - `// Handled by CSS media queries`,
 * `// Nothing to do here`, `// subclasses override this` all flagged working artifacts. Requiring
 * positive evidence inverts that: a verb missing from THIS list costs a missed detection, which is the
 * direction the rest of this module already leans.
 */
const BEHAVIOUR_VERB_PATTERN =
  /\b(?:render|redraw|draw|paint|wire|attach|bind|register|listen|initiali[sz]e|set\s?up|build|construct|create|generate|add|insert|append|remove|delete|clear|reset|update|refresh|recompute|recalculate|compute|calculate|apply|filter|sort|group|search|query|export|import|load|fetch|request|save|persist|store|populate|display|show|hide|toggle|expand|collapse|validate|sanitize|parse|serialize|format|emit|dispatch|publish|animate|scroll|focus|gather|collect|aggregate|sum|count|map|reduce)\b/i;

/** The "it would do X" construction, which describes absent work without naming a verb we listed. */
const WOULD_DO_PATTERN = /\bwould\s+(?:\w+\s+){0,2}\w+/i;

/**
 * Comment phrasings that DECLARE a body is meant to be empty. These override the positive evidence
 * above, so `// intentionally does not render anything` stays silent despite naming a verb.
 */
const NO_OP_INTENT_PATTERNS: readonly RegExp[] = [
  /\bintentional/i,
  /\bdo(?:es)? nothing\b/i,
  /\bnothing to do\b/i,
  /\bno-?op\b/i,
  /\bnot implemented\b/i,
  /\bunused\b/i,
  /\breserved\b/i,
  /\bdeliberately\b/i,
  /\bby design\b/i,
  /\bon purpose\b/i,
  /\bleft (?:empty|blank)\b/i,
  /\bhandled (?:by|in|elsewhere)\b/i,
  /\b(?:subclass|subclasses|override)\b/i,
  /\bignore[sd]?\b/i,
  /\bplaceholder for\b/i,
  /\bstub\b/i,
];

/**
 * Whether a hollow body's comment DESCRIBES the behaviour that is missing, rather than explaining an
 * intentional absence. This is the only thing separating two shapes that are identical to the scanner:
 *   `// intentionally does nothing - reserved for the print hook`  -> deliberate, stays silent
 *   `// Handled by CSS media queries`                              -> deliberate, stays silent
 *   `// Wire up the button and render the list`                    -> a stub, reported
 *   `// This function would clear each column`                     -> a stub, reported
 *
 * Requires POSITIVE evidence (a behaviour verb, or a "would do X" construction) and the absence of an
 * explicit no-op declaration. A body with no comment at all is deliberate: a stub explains itself.
 * Bare `// todo` deliberately does NOT qualify - it names no behaviour, and this file's stance is that
 * bare TODO is common in legitimate scaffolding.
 */
function describesMissingBehaviour(comment: string): boolean {
  const text = comment.replace(/[/*]|<!--|-->/g, ' ').trim();
  if (!text) return false;
  if (NO_OP_INTENT_PATTERNS.some(pattern => pattern.test(text))) return false;
  return BEHAVIOUR_VERB_PATTERN.test(text) || WOULD_DO_PATTERN.test(text);
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
  // arrow assigned to an existing, namespaced, or property binding: `window.render = () => {}`,
  // `btn.onclick = () => {}`, `el.dataset.handler = () => {}`. The optional dotted prefix matters:
  // `el.onclick = () => {}` is the commonest vanilla-JS handler shape in these artifacts, and
  // special-casing only `window.` missed every one of them. The NAME captured is the last segment.
  // Each prefix segment may carry an argument list, so the chain crosses a lookup call:
  // `document.getElementById('a').onclick = () => {}`.
  //
  // The repetition is BOUNDED at 8, and that bound is load-bearing rather than cosmetic. Unbounded,
  // this backtracks quadratically on chain-shaped input written with spaces around the dots
  // (`a . a . a ...`): the `\s*` makes every space a viable match start and each start re-walks the
  // remaining chain. Measured before the bound, through detectElidedContent on a `react` body:
  // 191ms / 771ms / 3119ms at 15 / 30 / 60KB. That runs synchronously on the completion path ahead of
  // quest save and billing settlement, so it is a HANG, which the surrounding crash guards cannot
  // catch - they only handle throws. Real handler chains are 2-3 segments, and this detector is
  // deliberately lossy, so the bound costs nothing observable.
  /(?:^|[\s;{}])(?:[A-Za-z_$][\w$]*(?:\s*\([^()]*\))?\s*\.\s*){0,8}([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{([^{}]*)\}/gm,
  // object-literal / class method shorthand: `render() {}`, `async load() {}`
  /(?:^|[\s;{,])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{([^{}]*)\}/gm,
];

/**
 * Extracts comment text - and ONLY comment text - then matches the stub phrases against it.
 * `#` is treated as a comment marker for python artifacts alone; elsewhere it is a CSS colour
 * or a URL fragment. A `//` IMMEDIATELY preceded by `:` is a URL scheme, not a comment - see the
 * guard in stripCommentsAndStrings for why adjacency rather than nearest-non-whitespace. This claim
 * described intended behaviour that the lexer did not actually implement until it was reported.
 */
function findPlaceholderComments(body: string, type?: ArtifactType): ElisionSignal[] {
  const found: ElisionSignal[] = [];
  const seenLines = new Set<number>();

  // Sorted by position, then walked with a RUNNING newline count. Computing each line number by
  // rescanning from index 0 made this O(comments x bodySize) - measured at 5.7s on a 720KB artifact
  // with one trailing comment per line, which is an ordinary shape rather than a steered one. Sorting
  // is required because the react/code path appends its HTML sweep after the JS spans.
  const comments = collectComments(body, type).sort((a, b) => a.start - b.start);
  let cursor = 0;
  let line = 1;

  for (const comment of comments) {
    for (; cursor < comment.start && cursor < body.length; cursor++) {
      if (body[cursor] === '\n') line++;
    }
    if (seenLines.has(line)) continue; // one signal per line is enough; keeps the payload small
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(comment.text)) {
        seenLines.add(line);
        found.push({ kind: 'placeholder_comment', match: comment.text.trim().slice(0, 200), line });
        break;
      }
    }
  }

  return found;
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
 * the gap, which also keeps the output ALIGNED with the input at every offset within the input, so
 * `collectInto` spans are valid indices into the original source. Not exactly length-preserving: an
 * unterminated construct at EOF can overshoot by a character or two, and the regex character-class
 * branch substitutes a space for a newline. Neither is reachable at any offset a caller uses - the
 * overshoot is past the end of the input, and reported line numbers are counted on the original body.
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

    // `scheme://host` is not a comment. Without this, the type-less reply-share fallback lexed prose
    // like `Docs: https://example.com/x - trimmed for brevity` as comment text and gated sharing a
    // healthy reply at HIGH confidence.
    //
    // Adjacency is required - the raw previous character, NOT `prevMeaningful`, which is what the
    // regex-literal check below uses. Skipping whitespace first would also swallow
    // `{ url: // a real comment }` and `cond ? a : // why`, which are ordinary comments; only the
    // no-space `url://x` form is ambiguous, and that reads as a URL far more often than a comment.
    //
    // WHERE A SKIPPED `//` ACTUALLY GOES, because the two halves are load-bearing together:
    // `startsRegexLiteral` already treats `:` as a regex-opening position, so the slashes fall into
    // the regex-literal branch below and are consumed as an empty literal rather than as code. Do not
    // "simplify" either half without re-checking the other - the pinned prose-URL and bare-`//host`
    // tests cover both directions.
    if (ch === '/' && next === '/' && source[i - 1] !== ':') {
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

// No `__testing` export: the tests drive `detectElidedContent` through its real inputs rather than
// reaching for the pattern tables, and this module is a dedicated subpath entry, so anything exported
// here is public surface for both consumers.
