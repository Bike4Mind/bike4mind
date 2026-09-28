import { TOOL_RESULT_TRUNCATION_NOTICE, getFullToolResult } from '@bike4mind/llm-adapters';
import type { ToolEchoSource } from '@bike4mind/utils';
import type { ToolsUsedEntry } from './toolsUsedToFunctionCalls';

/**
 * Tools whose output is third-party web content (deep_research returns scraped page text in
 * `data.findings`). Only these count as echo sources: output from the user's own content
 * (knowledge base, files) or an artifact emitter is meant to promote.
 */
export const TOOL_ECHO_SOURCE_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'web_search', 'deep_research']);

/** Total chars of tool output the echo matcher searches per reply. */
export const MAX_TOOL_ECHO_HAYSTACK_CHARS = 400_000;

// Must stay in sync with truncationMarker() in tools/implementation/webfetch/index.ts.
const WEB_FETCH_WINDOW_MARKER = '\n\n[web_fetch: showing chars ';

function stripWebFetchWindowMarker(text: string): string {
  const at = text.lastIndexOf(WEB_FETCH_WINDOW_MARKER);
  return at !== -1 && text.endsWith(']') ? text.slice(0, at) : text;
}

/** The web tool outputs a reply may have quoted back, for createToolEchoMatcher. */
export function buildToolEchoSources(toolsUsed: readonly ToolsUsedEntry[]): ToolEchoSource[] {
  const sources: ToolEchoSource[] = [];
  let budget = MAX_TOOL_ECHO_HAYSTACK_CHARS;
  for (const tool of toolsUsed) {
    if (budget <= 0) break;
    if (!TOOL_ECHO_SOURCE_TOOLS.has(tool.name)) continue;
    let text: string;
    let truncated: boolean;
    const full = getFullToolResult(tool);
    if (full && full.text !== '') {
      text = full.text;
      truncated = full.truncated;
    } else if (typeof tool.returnValue === 'string' && tool.returnValue !== '') {
      truncated = tool.returnValue.endsWith(TOOL_RESULT_TRUNCATION_NOTICE);
      text = truncated ? tool.returnValue.slice(0, -TOOL_RESULT_TRUNCATION_NOTICE.length) : tool.returnValue;
    } else {
      continue;
    }
    text = stripWebFetchWindowMarker(text);
    if (text.length > budget) {
      text = text.slice(0, budget);
      truncated = true;
    }
    if (text === '') continue;
    budget -= text.length;
    sources.push({ text, truncated });
  }
  return sources;
}

/**
 * buildToolEchoSources over persisted agent steps (AgentStep in @bike4mind/agents): an
 * observation step carries the tool's result in `content` and its name in `metadata.toolName`.
 */
export function buildToolEchoSourcesFromSteps(steps: unknown): ToolEchoSource[] {
  if (!Array.isArray(steps)) return [];
  const toolsUsed: ToolsUsedEntry[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const { type, content, metadata } = step as { type?: unknown; content?: unknown; metadata?: unknown };
    const toolName =
      metadata && typeof metadata === 'object' ? (metadata as { toolName?: unknown }).toolName : undefined;
    if (type !== 'observation' || typeof content !== 'string' || typeof toolName !== 'string') continue;
    toolsUsed.push({ name: toolName, returnValue: content });
  }
  return buildToolEchoSources(toolsUsed);
}
