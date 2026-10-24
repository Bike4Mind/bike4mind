/**
 * Standing permission rules, as the Settings screen sees them.
 *
 * The syntax is Claude Code's (`Bash(git status:*)`, `Read(~/notes/**)`, `WebFetch(domain:x)`,
 * `mcp__server__tool`), so a rule can be copied between the two. Rules are only ever written by
 * the user, from Settings or an approval card's "Always allow"; no tool the model can
 * call reaches them. See main/chat/permissions for how they are matched.
 */

export type PermissionList = 'allow' | 'ask' | 'deny';

export const PERMISSION_LISTS: readonly PermissionList[] = ['allow', 'ask', 'deny'];

export interface PermissionRuleLists {
  allow: string[];
  ask: string[];
  deny: string[];
}

/** Whose desktop rules: everything the user does, or one project (keyed by the folder they picked). */
export type PermissionScope = { kind: 'user' } | { kind: 'project'; directory: string };

export interface PermissionRuleView {
  rule: string;
  list: PermissionList;
  /** Why the rule is not applied: it does not parse, or names a tool this app does not have. */
  problem?: string;
}

export interface ClaudeCodeSourceView {
  id: string;
  label: string;
  path: string;
  status: 'loaded' | 'missing' | 'unreadable';
  /** Set when the file is read but some of it is not applied, e.g. an untrusted project's allows. */
  note?: string;
  rules: PermissionRuleView[];
  additionalDirectories: string[];
}

export interface PermissionsState {
  /** Whether Claude Code's own permission rules are read and applied here. */
  shareClaudeCode: boolean;
  user: PermissionRuleView[];
  projects: { directory: string; rules: PermissionRuleView[] }[];
  claudeCode: ClaudeCodeSourceView[];
}

export type PermissionMutationResult = { ok: true; state: PermissionsState } | { ok: false; error: string };
