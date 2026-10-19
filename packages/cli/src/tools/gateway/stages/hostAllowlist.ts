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

/** Whether the host allowlist (claude --allowedTools) auto-approves this tool. */
export function isHostAllowlisted(toolName: string): boolean {
  const allowedPatterns = getAllowedToolPatterns();
  return allowedPatterns.length > 0 && matchesAnyPattern(toolName, allowedPatterns);
}
