import { ClaudeArtifactMimeTypes } from '../types/entities/ArtifactTypes';
import { type ArtifactTagMemo, scanArtifactOpenTag } from './artifactOpenTag';

// The tools whose results may carry artifacts, each pinned to the one type it emits. Any other
// tool's output (web pages, files, MCP servers) is untrusted and can carry forged markup. Read by
// sharedToolBuilder (tool_result extraction) and llm-adapters toolStreamingHelper (reply streaming);
// a new artifact-emitting tool must be added here or its artifact is dropped on both paths.
export const TOOL_ARTIFACT_EMITTERS: ReadonlyMap<string, string> = new Map([
  ['recharts', ClaudeArtifactMimeTypes.RECHARTS],
  ['mermaid_chart', ClaudeArtifactMimeTypes.MERMAID],
  ['lattice_create_model', ClaudeArtifactMimeTypes.LATTICE],
  ['blog_draft', ClaudeArtifactMimeTypes.BLOG_DRAFT],
  ['chess_engine', ClaudeArtifactMimeTypes.CHESS],
]);

// Placeholders substituted for a stripped tool-result artifact block (see
// stripToolArtifactMarkup below), shared by every backend so the model gets a consistent
// account of what happened to its own tool call across providers.
export const ARTIFACT_DELIVERED_PLACEHOLDER = '[Artifact rendered and delivered to user]';
export const ARTIFACT_REMOVED_PLACEHOLDER = '[Artifact markup removed]';

// Value is anchored to its own quote kind so a double-quoted value can contain
// apostrophes (title="Bob's App") and vice versa. Must stay in sync with
// ATTRIBUTE_REGEX in @bike4mind/utils artifactParser.ts and the client mirror.
const TOOL_ATTR_RE = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;

/** Parses an artifact open tag's attributes; a repeated attribute keeps its last value. */
export function parseToolArtifactAttributes(attrsStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of attrsStr.matchAll(TOOL_ATTR_RE)) {
    attrs[match[1]] = match[2] ?? match[3];
  }
  return attrs;
}

/**
 * Returns `text` with every artifact tag not of `toolName`'s pinned type removed, or null when
 * the tool is not an emitter, no tag is kept, or the text holds an artifact opener outside a
 * kept, closed, un-nested tag (a client streaming parser would still render an unclosed tag).
 * Tags are read by scanArtifactOpenTag, the grammar of the reply parser that consumes the
 * streamed text, so a quoted ">" cannot end a tag here that the reply parser reads further.
 * A single forward scan: the input is tool output, so no per-opener rescan to the end.
 */
export function filterToolArtifactMarkup(toolName: string, text: string): string | null {
  const allowedType = TOOL_ARTIFACT_EMITTERS.get(toolName);
  if (allowedType === undefined) return null;
  const opener = /<artifact\b/gi;
  const memo: ArtifactTagMemo = {};
  const closer = /<\/artifact>/gi;
  let out = '';
  let cursor = 0;
  let kept = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    const tag = scanArtifactOpenTag(text, open.index, 'one', memo);
    if (!tag) return null;
    const bodyStart = tag.end;
    closer.lastIndex = bodyStart;
    const close = closer.exec(text);
    if (!close) return null;
    const keep = parseToolArtifactAttributes(tag.attrs).type === allowedType;
    if (keep) {
      if (/<artifact\b/i.test(text.slice(bodyStart, close.index))) return null;
      kept++;
    }
    out += text.slice(cursor, open.index) + (keep ? text.slice(open.index, closer.lastIndex) : '');
    cursor = closer.lastIndex;
    opener.lastIndex = cursor;
  }
  return kept > 0 ? out + text.slice(cursor) : null;
}

/**
 * Replaces each `<artifact ...>...</artifact>` block in a tool result with `placeholder`, so the
 * model never sees markup it could echo into its reply (where the reply parser would render it).
 * The open tag is read with the reply parser grammar, so a quoted `</artifact>` cannot end a block
 * early; an opener that does not parse or never closes drops the rest of the text. Linear.
 */
export function stripToolArtifactMarkup(text: string, placeholder: string): string {
  const opener = /<artifact\b/gi;
  const memo: ArtifactTagMemo = {};
  const closer = /<\/artifact>/gi;
  let out = '';
  let cursor = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    out += text.slice(cursor, open.index) + placeholder;
    const tag = scanArtifactOpenTag(text, open.index, 'one', memo);
    if (!tag) return out;
    closer.lastIndex = tag.end;
    if (!closer.exec(text)) return out;
    cursor = closer.lastIndex;
    opener.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}

/**
 * Parses the `identifier` attribute out of every complete artifact tag opener in `markup`.
 * `markup` here is always content this codebase generated itself (artifact text already
 * streamed to the client). Matches a `gi` scan of `<artifact\s(ATTRS)>`.
 */
function extractArtifactIdentifiers(markup: string): Set<string> {
  const ids = new Set<string>();
  const memo: ArtifactTagMemo = {};
  const opener = /<artifact/gi;
  for (let open = opener.exec(markup); open; open = opener.exec(markup)) {
    const tag = scanArtifactOpenTag(markup, open.index, 'one', memo);
    if (!tag) {
      opener.lastIndex = open.index + 1;
      continue;
    }
    const identifier = parseToolArtifactAttributes(tag.attrs).identifier;
    if (identifier !== undefined) ids.add(identifier);
    opener.lastIndex = tag.end;
  }
  return ids;
}

/**
 * Removes only the artifact blocks in `text` whose `identifier` attribute matches one already
 * delivered to the client this turn (present in `deliveredMarkup`, the exact markup already
 * streamed) - leaving a stray/unclosed opener, and any OTHER complete block (a genuinely new
 * artifact the model composes in its own reply, with a different identifier), untouched. Unlike
 * stripToolArtifactMarkup (built for tool output, where an adversarial unclosed opener should
 * nuke the rest), this is for a model's own free-form reply text: prose that merely mentions
 * "<artifact" or a block truncated by a token ceiling must not cost the rest of a legitimate
 * reply, and a distinct artifact the model deliberately authors must not be mistaken for an
 * echo of one already delivered. Used by the recursive-reply artifact guard only.
 */
export function stripDeliveredArtifactBlocks(text: string, deliveredMarkup: string): string {
  const deliveredIdentifiers = extractArtifactIdentifiers(deliveredMarkup);
  if (deliveredIdentifiers.size === 0) return text;
  const opener = /<artifact\b/gi;
  const memo: ArtifactTagMemo = {};
  const closer = /<\/artifact>/gi;
  let out = '';
  let cursor = 0;
  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    // Cheap O(1) rejection before the scan below: no whitespace immediately after
    // "artifact" can never open a tag here, no matter how the rest of the text reads - skip to
    // the next opener match, same as a real reply parser would.
    if (!/\s/.test(text[open.index + 9] ?? '')) {
      opener.lastIndex = open.index + 1;
      continue;
    }
    const tag = scanArtifactOpenTag(text, open.index, 'one', memo);
    if (!tag) {
      // No unquoted `>` closes this tag before the end of the string. Stop scanning -
      // everything from here to the end is kept literally below.
      break;
    }
    closer.lastIndex = tag.end;
    const close = closer.exec(text);
    if (!close) {
      // Same reasoning: an unclosed tag here means nothing closes anywhere later either
      // (closer is a plain substring search, not scoped to this tag).
      break;
    }
    const identifier = parseToolArtifactAttributes(tag.attrs).identifier;
    const remove = identifier !== undefined && deliveredIdentifiers.has(identifier);
    out += text.slice(cursor, open.index) + (remove ? '' : text.slice(open.index, closer.lastIndex));
    cursor = closer.lastIndex;
    opener.lastIndex = cursor;
  }
  return out + text.slice(cursor);
}
