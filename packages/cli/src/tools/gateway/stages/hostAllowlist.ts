import { matchesAnyPattern } from '../../../agents/toolFilter.js';

/**
 * Tool-name patterns auto-approved without a permission prompt, from `--allowedTools`
 * (claude-compat; e.g. `mcp__manifold__*`). Parsed once from B4M_ALLOWED_TOOLS - set by
 * bin/bike4mind-cli.mjs. Returns [] when unset so behaviour is unchanged off-host.
 */
let cachedAllowedTools: string[] | undefined;
function getAllowedToolPatterns(): string[] {
  if (cachedAllowedTools === undefined) {
    try {
      const raw = process.env.B4M_ALLOWED_TOOLS;
      cachedAllowedTools = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      cachedAllowedTools = [];
    }
  }
  return cachedAllowedTools;
}

const CLAUDE_MCP_PREFIX = 'mcp__';

/**
 * Whether the host allowlist (claude --allowedTools) auto-approves this tool.
 *
 * MCP tools reach the model as `<server>__<tool>` (toolGenerators.ts namespaces them that way),
 * but claude's `--allowedTools` convention - and the example in our own --help - is
 * `mcp__<server>__<tool>`. For a tool known to come from an MCP server, also test the
 * claude-form name so `mcp__host__*` approves `host__read_self`. The flag comes from
 * the tool object (`_isMcpTool`), never from the name, so a `mcp__` pattern cannot reach a
 * built-in or plugin tool that merely has `__` in its name.
 */
export function isHostAllowlisted(toolName: string, opts: { isMcpTool?: boolean } = {}): boolean {
  const allowedPatterns = getAllowedToolPatterns();
  if (allowedPatterns.length === 0) return false;
  if (matchesAnyPattern(toolName, allowedPatterns)) return true;
  return opts.isMcpTool === true && matchesAnyPattern(`${CLAUDE_MCP_PREFIX}${toolName}`, allowedPatterns);
}

/** Test seam: drop the parsed B4M_ALLOWED_TOOLS so the next call re-reads the env. */
export function __resetHostAllowlistCacheForTests(): void {
  cachedAllowedTools = undefined;
}
