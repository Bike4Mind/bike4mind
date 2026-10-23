/**
 * Startup decisions for the two interactive trust prompts that init() can show before anything
 * repo-sourced loads: the folder-trust prompt and the repo MCP-definition approval prompt.
 *
 * Kept pure (no Ink, no ConfigStore) so the decision is testable without rendering the app.
 */

/**
 * The B4M_* variables bin/bike4mind-cli.mjs sets from the claude-compatible host flags
 * (--mcp-config, --append-system-prompt, --allowedTools, --settings, --session-id, --resume).
 * A person at a terminal has no reason to pass these; a host app that launches b4m as a
 * drop-in for `claude` passes them on every launch.
 */
const HOST_FLAG_ENV_KEYS = [
  'B4M_MCP_CONFIG_FILE',
  'B4M_APPEND_SYSTEM_PROMPT',
  'B4M_ALLOWED_TOOLS',
  'B4M_SETTINGS_JSON',
  'B4M_SESSION_ID',
  'B4M_RESUME_ID',
] as const;

/**
 * Whether this is a host-driven launch with work already queued: an initial prompt (the
 * claude `<prompt>` positional, auto-submitted once init completes) AND at least one host flag.
 *
 * Both are required. A bare `b4m "task"` is a person at the terminal who can answer a prompt,
 * so it keeps today's behaviour. Host flags with no queued prompt also keep it: nothing is
 * waiting, and whoever is looking at the pane can answer. Only the combination means a prompt
 * would block work that no one is watching for.
 */
export function isHostLaunchWithQueuedPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.B4M_INITIAL_PROMPT) return false;
  return HOST_FLAG_ENV_KEYS.some(key => Boolean(env[key]));
}

export type FolderTrustGateInput = {
  /** The gate already ran this process (init() re-runs after login / env pick). */
  alreadyResolved: boolean;
  projectTrusted: boolean;
  projectHasB4mFiles: boolean;
  isTty: boolean;
  hostLaunch: boolean;
};

/**
 * - `prompt`: show the interactive folder-trust prompt.
 * - `inert`: do not prompt; repo config stays inert this session (the prompt's "Not now"
 *   outcome, nothing persisted) and the caller prints a one-line notice.
 * - `none`: nothing to decide (already trusted, nothing to gate, already resolved), or a
 *   non-interactive run, which stays untrusted silently as before.
 */
export type FolderTrustGateDecision = 'prompt' | 'inert' | 'none';

export function decideFolderTrustGate(input: FolderTrustGateInput): FolderTrustGateDecision {
  if (input.alreadyResolved || input.projectTrusted || !input.projectHasB4mFiles || !input.isTty) return 'none';
  return input.hostLaunch ? 'inert' : 'prompt';
}

export type McpApprovalGateInput = {
  alreadyResolved: boolean;
  pendingCount: number;
  isTty: boolean;
  hostLaunch: boolean;
};

/**
 * Whether to show the repo MCP-definition approval prompt. When it is not shown, the pending
 * servers stay off this session and the caller warns once - the same outcome as declining it,
 * or as a non-interactive run, with nothing persisted.
 */
export function shouldPromptMcpApproval(input: McpApprovalGateInput): boolean {
  return input.pendingCount > 0 && !input.alreadyResolved && input.isTty && !input.hostLaunch;
}

/** The one-line notice printed when a host launch leaves an untrusted folder's config inert. */
export function hostInertNotice(projectRoot: string): string {
  return (
    `Project config in ${projectRoot} left inert (host launch with a queued prompt; no trust prompt shown). ` +
    'Run /trust folder to trust it.'
  );
}
