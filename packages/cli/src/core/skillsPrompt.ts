import type { CustomCommand } from '../storage/types.js';

/**
 * Get the display name for a skill
 * Prefers displayName from frontmatter, falls back to filename-derived name
 */
function getSkillDisplayName(cmd: CustomCommand): string {
  return cmd.displayName || cmd.name;
}

/**
 * Format a single skill entry for the prompt
 */
function formatSkillEntry(cmd: CustomCommand): string {
  const displayName = getSkillDisplayName(cmd);
  const argHint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
  // Show both display name and actual command name if different
  const nameDisplay =
    cmd.displayName && cmd.displayName !== cmd.name ? `**${displayName}** (\`${cmd.name}\`)` : `**${cmd.name}**`;
  return `- ${nameDisplay}${argHint}: ${cmd.description}\n`;
}

/**
 * Format a list of skills under a heading
 */
function formatSkillGroup(heading: string, commands: CustomCommand[]): string {
  if (commands.length === 0) {
    return '';
  }
  return `\n### ${heading}\n${commands.map(formatSkillEntry).join('')}`;
}

/**
 * Filter skills that should be visible to the AI in the system prompt
 * Excludes skills with disableModelInvocation: true
 *
 * @param commands - Array of all loaded custom commands
 * @returns Filtered array of commands visible to AI
 */
export function filterAIVisibleSkills(commands: CustomCommand[]): CustomCommand[] {
  return commands.filter(cmd => !cmd.disableModelInvocation);
}

/**
 * Filter skills by an allowed list
 * If allowedSkills is empty/undefined, returns all skills (backwards compatible)
 *
 * @param commands - Array of all commands
 * @param allowedSkills - Optional whitelist of skill names
 * @returns Filtered array of commands
 */
export function filterSkillsByAllowedList(commands: CustomCommand[], allowedSkills?: string[]): CustomCommand[] {
  if (!allowedSkills || allowedSkills.length === 0) {
    return commands;
  }
  return commands.filter(cmd => allowedSkills.includes(cmd.name));
}

/**
 * Filter skills that should be visible to users in the /commands menu
 * Excludes skills with userInvocable: false
 *
 * @param commands - Array of all loaded custom commands
 * @returns Filtered array of commands visible in user menu
 */
export function filterUserVisibleSkills(commands: CustomCommand[]): CustomCommand[] {
  return commands.filter(cmd => cmd.userInvocable !== false);
}

/**
 * Build the skills section for the system prompt
 *
 * This section lists all available skills (custom commands) that the AI
 * can invoke using the `skill` tool. Skills are grouped by source
 * (project vs global).
 *
 * Note: Skills with disableModelInvocation: true are excluded from this list
 * but can still be invoked programmatically if the AI knows about them.
 *
 * @param commands - Array of all loaded custom commands
 * @param allowedSkills - Optional whitelist of skill names (undefined = all skills)
 * @returns Formatted string to append to system prompt, or empty string if no commands
 */
export function buildSkillsPromptSection(commands: CustomCommand[], allowedSkills?: string[]): string {
  // Apply allowed skills filter first (for agent-specific restrictions)
  const filteredByAllowed = filterSkillsByAllowedList(commands, allowedSkills);

  // Then filter out skills that should not be auto-loaded by the AI
  const visibleCommands = filterAIVisibleSkills(filteredByAllowed);

  if (visibleCommands.length === 0) {
    return '';
  }

  const projectSkills = visibleCommands.filter(c => c.source === 'project');
  const globalSkills = visibleCommands.filter(c => c.source === 'global');

  // Project skills take precedence and are shown first
  return (
    `\n\n## Available Skills\n\n` +
    `**IMPORTANT:** When the user's request matches a skill's description, ALWAYS use the \`skill\` tool to invoke it ` +
    `instead of attempting the task directly with other tools (e.g., do NOT use bash_execute for browser automation ` +
    `when a playwright skill is available). Skills contain specialized instructions and context.\n\n` +
    `Example: skill({ skill: "commit" })\n` +
    formatSkillGroup('Project Skills', projectSkills) +
    formatSkillGroup('Global Skills', globalSkills)
  );
}
