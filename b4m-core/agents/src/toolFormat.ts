/**
 * Tool name formatting utilities for human-readable display
 *
 * Converts raw MCP tool names like "atlassian__jira_search_issues"
 * into human-readable actions like "searching issues".
 */

/** Known product prefixes to strip from tool names */
const PRODUCT_PREFIXES = ['jira', 'confluence', 'github', 'bitbucket'];

/**
 * Convert a raw tool name into a human-readable gerund phrase.
 *
 * Examples:
 *   - "atlassian__jira_search_issues" -> "searching issues"
 *   - "github__list_pull_requests"    -> "listing pull requests"
 *   - "web_search"                    -> "searching"
 *   - "create_issue"                  -> "creating issue"
 */
export function humanizeToolName(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;

  // Strip double-underscore MCP prefix: "atlassian__jira_search_issues" -> "jira_search_issues"
  const withoutServer = toolName.replace(/^[a-z]+__/, '');

  // Strip known product prefixes
  const stripped = PRODUCT_PREFIXES.reduce(
    (name, prefix) => name.replace(new RegExp(`^${prefix}_`), ''),
    withoutServer
  );

  const words = stripped.replace(/_/g, ' ').trim();
  if (!words) return undefined;

  const parts = words.split(' ');
  const verb = parts[0];
  const rest = parts.slice(1).join(' ');

  return rest ? `${toGerund(verb)} ${rest}` : toGerund(verb);
}

/**
 * Convert a verb to its gerund (-ing) form.
 *
 * Examples:
 *   - "search"  -> "searching"
 *   - "get"     -> "getting"
 *   - "create"  -> "creating"
 *   - "running" -> "running" (already a gerund)
 */
export function toGerund(verb: string): string {
  // Already a gerund
  if (verb.endsWith('ing')) return verb;

  // CVC doubling: get->getting, run->running, set->setting
  // (single-syllable, ends in consonant-vowel-consonant, last consonant not w/x/y)
  const cvcPattern = /^[^aeiou]*[aeiou][bcdfghjklmnpqrstvz]$/;
  if (cvcPattern.test(verb)) {
    return verb + verb.slice(-1) + 'ing';
  }

  // Silent-e: create->creating, update->updating
  if (verb.endsWith('e') && !verb.endsWith('ee')) {
    return verb.slice(0, -1) + 'ing';
  }

  return verb + 'ing';
}
