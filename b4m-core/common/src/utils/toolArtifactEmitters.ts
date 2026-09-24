import { ClaudeArtifactMimeTypes } from '../types/entities/ArtifactTypes';

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
 * the tool is not an emitter or the text holds an artifact opener outside a kept, closed tag
 * (a client streaming parser would still render an unclosed tag).
 */
export function filterToolArtifactMarkup(toolName: string, text: string): string | null {
  const allowedType = TOOL_ARTIFACT_EMITTERS.get(toolName);
  if (allowedType === undefined) return null;
  let kept = 0;
  const filtered = text.replace(/<artifact\s+([^>]*)>[\s\S]*?<\/artifact>/gi, (tag, attrsStr: string) => {
    if (parseToolArtifactAttributes(attrsStr).type !== allowedType) return '';
    kept++;
    return tag;
  });
  const openers = filtered.match(/<artifact\b/gi)?.length ?? 0;
  return openers === kept ? filtered : null;
}
