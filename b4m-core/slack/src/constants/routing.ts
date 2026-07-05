/**
 * Maps a targetSystem value to the subagent that should handle it.
 *
 * Used in both agent-parser.ts (system prompt ROUTING DIRECTIVE) and
 * CommandHandler.ts (user message [ROUTING: ...] prefix) to ensure
 * consistent delegation.
 */
export const TARGET_SYSTEM_AGENT_MAP: Record<string, string> = {
  github: 'github_manager',
  jira: 'project_manager',
  confluence: 'project_manager',
};

/**
 * Maps agent short-names to their canonical target system.
 *
 * Used by:
 *   - CommandHandler.inferTargetSystemFromAgent() - post-regex override
 *   - CommandHandler.classifyRouting() - fast-path LLM skip
 */
export const AGENT_SYSTEM_DEFAULTS = {
  dev: 'github',
  pm: 'jira',
} as const satisfies Record<string, 'github' | 'jira' | 'confluence'>;
