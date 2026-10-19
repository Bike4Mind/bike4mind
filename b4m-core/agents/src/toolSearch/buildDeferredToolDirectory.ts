/**
 * Render the deferred-tool directory: names only, no descriptions.
 * Following Claude Code's pattern, MCP tools have self-describing names
 * (e.g. mcp__github__create_pull_request) that the model parses without
 * needing extra text. The model can also call `tool_search` with free-text
 * keywords for non-obvious names.
 */
export function buildDeferredToolDirectory(names: string[]): string {
  if (names.length === 0) return '';
  const sorted = [...names].sort();
  return `

## Deferred tool schemas

The following ${sorted.length} tool(s) are available but their parameter schemas are NOT loaded by default to save context. Calling them directly will fail with "Tool not found". Use the \`tool_search\` tool to load schemas on demand:
- Exact selection: \`tool_search(query="select:<name>[,<name>...]")\`
- Keyword search: \`tool_search(query="<free text>")\`

Once a tool's schema is loaded, it becomes callable in subsequent turns. Deferred tool names:

${sorted.join('\n')}`;
}
