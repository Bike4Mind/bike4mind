/**
 * Tool filtering utilities for agent tool access control
 *
 * Provides wildcard pattern matching for tool names, enabling flexible
 * control over which tools are available to agents.
 *
 * Examples:
 *   - 'web_search' - exact match
 *   - 'mcp__github__*' - all tools from github MCP server
 *   - 'mcp__*__read_*' - all read tools from any MCP server
 *   - '*_file' - any tool ending with _file
 */

import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

/**
 * Check if a tool name matches a pattern
 *
 * Supports wildcards (*) that match any sequence of characters.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${regexPattern}$`).test(toolName);
}

/**
 * Check if a tool name matches any pattern in a list
 */
export function matchesAnyPattern(toolName: string, patterns: string[]): boolean {
  return patterns.some(pattern => matchesToolPattern(toolName, pattern));
}

/**
 * Filter tools based on allowed and denied patterns
 *
 * Rules:
 * 1. Denied patterns take precedence over allowed patterns
 * 2. If no allowed patterns specified, all tools are allowed (minus denied)
 * 3. If allowed patterns specified, only matching tools are allowed
 * 4. Supports wildcards in both allowed and denied patterns
 */
export function filterToolsByPatterns(
  allTools: ICompletionOptionTools[],
  allowedPatterns?: string[],
  deniedPatterns?: string[]
): ICompletionOptionTools[] {
  return allTools.filter(tool => {
    const toolName = tool.toolSchema.name;

    // Check denied first (deny takes precedence)
    if (deniedPatterns && deniedPatterns.length > 0) {
      if (matchesAnyPattern(toolName, deniedPatterns)) {
        return false;
      }
    }

    // If no allowed patterns specified, allow all (minus denied)
    if (!allowedPatterns || allowedPatterns.length === 0) {
      return true;
    }

    // Check if matches any allowed pattern
    return matchesAnyPattern(toolName, allowedPatterns);
  });
}

/**
 * Get tool names from a list of tools
 */
export function getToolNames(tools: ICompletionOptionTools[]): string[] {
  return tools.map(tool => tool.toolSchema.name);
}

/**
 * Validate a tool pattern syntax
 */
export function isValidToolPattern(pattern: string): boolean {
  if (!pattern || pattern.length === 0) {
    return false;
  }

  if (pattern.length > 100) {
    return false;
  }

  const validChars = /^[a-zA-Z0-9_*]+$/;
  return validChars.test(pattern);
}
