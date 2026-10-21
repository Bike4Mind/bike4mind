/** True when a raw MCP tool result is flagged `isError` (the shape the Atlassian tools return on failure). */
export function isMcpToolError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

/** First text block of a raw MCP tool result, for surfacing a tool's own error message. */
export function getMcpToolText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text: unknown = (content[0] as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}
