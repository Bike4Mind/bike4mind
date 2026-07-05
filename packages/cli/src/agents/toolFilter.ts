/**
 * Tool filtering utilities for the Unified Agent System
 *
 * Provides wildcard pattern matching for tool names, enabling flexible
 * control over which tools are available to agents.
 *
 * Examples:
 *   - 'file_read' - exact match
 *   - 'mcp__github__*' - all tools from github MCP server
 *   - 'mcp__*__read_*' - all read tools from any MCP server
 *   - '*_file' - any tool ending with _file
 */

import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

/**
 * Check if a tool name matches a pattern
 *
 * Supports wildcards (*) that match any sequence of characters.
 *
 * @param toolName - The actual tool name to check
 * @param pattern - The pattern to match against (may include * wildcards)
 * @returns true if the tool name matches the pattern
 *
 * @example
 * matchesToolPattern('mcp__github__create_issue', 'mcp__github__*') // true
 * matchesToolPattern('mcp__github__delete_repo', 'mcp__*__delete_*') // true
 * matchesToolPattern('file_read', 'file_read') // true
 * matchesToolPattern('file_read', 'file_*') // true
 * matchesToolPattern('file_read', '*_read') // true
 * matchesToolPattern('bash_execute', 'file_*') // false
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  // Convert wildcard pattern to regex
  // Escape special regex characters except *
  const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  return new RegExp(`^${regexPattern}$`).test(toolName);
}

/**
 * Check if a tool name matches any pattern in a list
 *
 * @param toolName - The tool name to check
 * @param patterns - Array of patterns to match against
 * @returns true if the tool matches any pattern
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
 *
 * @param allTools - Complete list of available tools
 * @param allowedPatterns - Whitelist patterns (optional)
 * @param deniedPatterns - Blacklist patterns (optional)
 * @returns Filtered list of tools
 *
 * @example
 * // Allow only specific tools
 * filterToolsByPatterns(tools, ['file_read', 'grep_search'])
 *
 * // Allow all GitHub MCP tools except delete operations
 * filterToolsByPatterns(tools, ['mcp__github__*'], ['mcp__github__delete_*'])
 *
 * // Deny specific tools, allow everything else
 * filterToolsByPatterns(tools, undefined, ['create_file', 'edit_file'])
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
 *
 * @param tools - List of tools
 * @returns Array of tool names
 */
export function getToolNames(tools: ICompletionOptionTools[]): string[] {
  return tools.map(tool => tool.toolSchema.name);
}

/**
 * Validate a tool pattern syntax
 *
 * @param pattern - The pattern to validate
 * @returns true if the pattern is valid
 */
export function isValidToolPattern(pattern: string): boolean {
  if (!pattern || pattern.length === 0) {
    return false;
  }

  // Pattern should only contain alphanumeric, underscore, asterisk
  // and be reasonable in length
  if (pattern.length > 100) {
    return false;
  }

  // Asterisks are allowed, but check for obviously invalid patterns
  // like consecutive asterisks or starting/ending with double underscore incorrectly
  const validChars = /^[a-zA-Z0-9_*]+$/;
  return validChars.test(pattern);
}
