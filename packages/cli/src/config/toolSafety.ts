import { z } from 'zod';

/**
 * Tool safety categories determine when permission is required
 */
export const ToolCategorySchema = z.enum([
  'auto_approve', // Safe tools that run automatically without permission
  'prompt_always', // Dangerous tools that ALWAYS require permission (cannot be trusted)
  'prompt_default', // Tools that prompt by default but can be trusted
]);

export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/**
 * Tool safety configuration schema
 */
export const ToolSafetyConfigSchema = z.object({
  categories: z.record(z.string(), ToolCategorySchema),
  trustedTools: z.array(z.string()),
});

export type ToolSafetyConfig = z.infer<typeof ToolSafetyConfigSchema>;

/**
 * Default tool categories
 *
 * Categories:
 * - auto_approve: Safe tools that don't need permission (math, search, datetime)
 * - prompt_always: Dangerous tools that ALWAYS need permission, cannot be trusted (file edits, shell commands)
 * - prompt_default: Tools that prompt by default but users can trust them (file reads, searches)
 */
export const DEFAULT_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Auto-approve: no side effects, safe to run without permission
  math_evaluate: 'auto_approve',
  current_datetime: 'auto_approve',
  dice_roll: 'auto_approve',
  prompt_enhancement: 'auto_approve',
  find_definition: 'auto_approve',
  ask_user_question: 'auto_approve',
  weather_info: 'prompt_default',

  // Prompt-always: modify files or run code; always require permission, cannot be trusted
  edit_file: 'prompt_always',
  edit_local_file: 'prompt_always',
  create_file: 'prompt_always',
  delete_file: 'prompt_always',
  shell_execute: 'prompt_always',
  bash_execute: 'prompt_always',
  // Background-shell mutators: writing input to / killing a running process is an action.
  write_shell_stdin: 'prompt_always',
  kill_background_shell: 'prompt_always',
  git_commit: 'prompt_always',
  git_push: 'prompt_always',

  // Prompt-default: read-only; prompts by default but can be trusted
  web_search: 'prompt_default',
  // Background-shell reads: polling output / listing sessions has no side effects.
  check_shell_output: 'prompt_default',
  list_background_shells: 'prompt_default',
  web_fetch: 'prompt_default',
  deep_research: 'prompt_default',
  file_read: 'prompt_default',
  grep_search: 'prompt_default',
  glob_files: 'prompt_default',
  get_file_tree: 'prompt_default',
  get_file_structure: 'prompt_default',
  git_status: 'prompt_default',
  git_diff: 'prompt_default',
  git_log: 'prompt_default',
  git_branch: 'prompt_default',
};

/**
 * Get the category for a tool
 * Returns 'prompt_default' if tool is not in the default categories
 */
export function getToolCategory(toolName: string, customCategories?: Record<string, ToolCategory>): ToolCategory {
  // Check custom categories first
  if (customCategories && toolName in customCategories) {
    return customCategories[toolName];
  }

  // Fall back to default categories
  if (toolName in DEFAULT_TOOL_CATEGORIES) {
    return DEFAULT_TOOL_CATEGORIES[toolName];
  }

  // Unknown tools default to requiring permission
  return 'prompt_default';
}

/**
 * Check if a tool can be trusted (not prompt_always)
 */
export function canTrustTool(toolName: string, customCategories?: Record<string, ToolCategory>): boolean {
  const category = getToolCategory(toolName, customCategories);
  return category !== 'prompt_always';
}

/**
 * Check if a tool is read-only (safe for parallel execution).
 * Write tools (prompt_always category) must always be sequential.
 *
 * @param toolName - Name of the tool to check
 * @param customCategories - Optional custom category overrides
 * @returns true if the tool is read-only, false if it's a write tool
 */
export function isReadOnlyTool(toolName: string, customCategories?: Record<string, ToolCategory>): boolean {
  return getToolCategory(toolName, customCategories) !== 'prompt_always';
}
