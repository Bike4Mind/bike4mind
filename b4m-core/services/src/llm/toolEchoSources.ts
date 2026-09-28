import { TOOL_ARTIFACT_EMITTERS } from '@bike4mind/common';
import { TOOL_RESULT_TRUNCATION_NOTICE } from '@bike4mind/llm-adapters';
import type { ToolEchoSource } from '@bike4mind/utils';
import type { ToolsUsedEntry } from './toolsUsedToFunctionCalls';

/** Total chars of tool output the echo matcher searches per reply. */
export const MAX_TOOL_ECHO_HAYSTACK_CHARS = 400_000;

// Must stay in sync with truncationMarker() in tools/implementation/webfetch/index.ts.
const WEB_FETCH_WINDOW_MARKER = '\n\n[web_fetch: showing chars ';

function stripWebFetchWindowMarker(text: string): string {
  const at = text.lastIndexOf(WEB_FETCH_WINDOW_MARKER);
  return at !== -1 && text.endsWith(']') ? text.slice(0, at) : text;
}

/**
 * The tool outputs a reply may have quoted back, for createToolEchoMatcher. Tools in
 * TOOL_ARTIFACT_EMITTERS are skipped: their output is meant to become an artifact.
 */
export function buildToolEchoSources(toolsUsed: readonly ToolsUsedEntry[]): ToolEchoSource[] {
  const sources: ToolEchoSource[] = [];
  let budget = MAX_TOOL_ECHO_HAYSTACK_CHARS;
  for (const tool of toolsUsed) {
    if (budget <= 0) break;
    if (TOOL_ARTIFACT_EMITTERS.has(tool.name)) continue;
    let text: string;
    let truncated: boolean;
    if (typeof tool.fullReturnValue === 'string' && tool.fullReturnValue !== '') {
      text = tool.fullReturnValue;
      truncated = false;
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
