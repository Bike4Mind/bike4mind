/**
 * Trust gate for hook shell execution.
 *
 * Skill lifecycle hooks (skillTool) and agent lifecycle hooks (SubagentOrchestrator)
 * shell out directly via runShellCommand, bypassing the per-tool PermissionManager
 * that a normal bash_execute must pass. A hook defined inside an untrusted checkout
 * (a project skill/agent), fetched from the server (remote), or generated at runtime
 * (dynamic) would therefore run arbitrary code the moment the file is invoked -
 * defeating the CLI's repo-trust boundary.
 *
 * Until hooks route through the full permission/risk-classification/sandbox path
 * (tracked by the folder-trust work), this is a fail-closed stopgap: only hooks from
 * sources the user themselves controls - the CLI's own builtin code and the user's
 * global (~/.bike4mind) config - are executed. Everything else is skipped.
 */

export type HookSource = 'builtin' | 'global' | 'project' | 'remote' | 'dynamic';

const TRUSTED_HOOK_SOURCES: ReadonlySet<HookSource> = new Set<HookSource>(['builtin', 'global']);

export function isTrustedHookSource(source: HookSource | undefined): boolean {
  return source !== undefined && TRUSTED_HOOK_SOURCES.has(source);
}
