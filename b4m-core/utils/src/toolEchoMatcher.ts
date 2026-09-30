/** One tool observation the model saw this turn; `truncated` means `text` is only a prefix of it. */
export interface ToolEchoSource {
  text: string;
  truncated: boolean;
}

/** Bodies shorter than this are too generic to call an echo. */
export const MIN_TOOL_ECHO_LENGTH = 64;
const TRUNCATED_PROBE_LENGTH = 256;
const TRUNCATED_MAX_PROBE_HITS = 8;
// A truncated source only vouches for a body when the overlap it proves is substantial.
const TRUNCATED_MIN_OVERLAP = 1024;
const JSON_MAX_DEPTH = 4;
const JSON_MAX_LEAVES = 50;

const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;
const HTML_ENTITY = /&(amp|lt|gt|quot|#39|nbsp);/g;
const ENTITY_TEXT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const WHITESPACE_RUN = /\s+/g;

/**
 * Canonical form for echo comparison: markdown backslash escapes removed, the common
 * HTML entities decoded once, whitespace runs collapsed to one space, trimmed. Each
 * step is a single linear pass.
 */
export function normalizeForToolEcho(value: string): string {
  return value
    .replace(MARKDOWN_ESCAPE, '$1')
    .replace(HTML_ENTITY, (_m, name: string) => ENTITY_TEXT[name])
    .replace(WHITESPACE_RUN, ' ')
    .trim();
}

function collectJsonStringLeaves(value: unknown, depth: number, out: string[]): void {
  if (out.length >= JSON_MAX_LEAVES) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (depth >= JSON_MAX_DEPTH || !value || typeof value !== 'object') return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectJsonStringLeaves(child, depth + 1, out);
    if (out.length >= JSON_MAX_LEAVES) return;
  }
}

interface Haystack {
  text: string;
  truncated: boolean;
}

function buildHaystacks(sources: readonly ToolEchoSource[]): Haystack[] {
  const haystacks: Haystack[] = [];
  for (const source of sources) {
    if (!source.text) continue;
    haystacks.push({ text: normalizeForToolEcho(source.text), truncated: source.truncated });
    // A JSON tool result carries HTML with its quotes and newlines escaped, so the model's
    // quote only matches the decoded string values. A truncated JSON body does not parse.
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.text);
    } catch {
      continue;
    }
    const leaves: string[] = [];
    collectJsonStringLeaves(parsed, 0, leaves);
    for (const leaf of leaves) haystacks.push({ text: normalizeForToolEcho(leaf), truncated: false });
  }
  return haystacks;
}

/**
 * True when the body extends past the end of a truncated source: the source's tail from
 * some probe hit onward is a prefix of the body, and that overlap is long enough to trust.
 */
function continuesTruncatedSource(body: string, hay: string): boolean {
  const probe = body.slice(0, TRUNCATED_PROBE_LENGTH);
  let from = 0;
  for (let hits = 0; hits < TRUNCATED_MAX_PROBE_HITS; hits++) {
    const offset = hay.indexOf(probe, from);
    if (offset === -1) return false;
    if (hay.length - offset >= TRUNCATED_MIN_OVERLAP && body.startsWith(hay.slice(offset))) return true;
    from = offset + 1;
  }
  return false;
}

/**
 * Builds a predicate that says whether a reply body (a fence body or bare document) is a
 * verbatim quote of one of this turn's tool observations rather than something the model
 * authored. Comparison is on normalizeForToolEcho output, so escaping and whitespace
 * differences introduced by quoting do not defeat it.
 */
export function createToolEchoMatcher(sources: readonly ToolEchoSource[]): (body: string) => boolean {
  const haystacks = buildHaystacks(sources);
  return (body: string): boolean => {
    if (haystacks.length === 0) return false;
    const normalized = normalizeForToolEcho(body);
    if (normalized.length < MIN_TOOL_ECHO_LENGTH) return false;
    return haystacks.some(
      hay => hay.text.includes(normalized) || (hay.truncated && continuesTruncatedSource(normalized, hay.text))
    );
  };
}
