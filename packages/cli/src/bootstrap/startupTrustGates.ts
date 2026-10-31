/**
 * Startup decisions for the two interactive trust prompts that init() can show before anything
 * repo-sourced loads: the folder-trust prompt and the repo MCP-definition approval prompt.
 *
 * Kept pure (no Ink, no ConfigStore) so the decision is testable without rendering the app.
 */

import { escapeTerminalControlChars } from '../utils/sanitizeTerminalText.js';

/**
 * The B4M_* variables bin/bike4mind-cli.mjs sets from the claude-compatible host flags
 * (--mcp-config, --append-system-prompt, --allowedTools, --settings, --session-id, --resume).
 * A host app that launches b4m as a drop-in for `claude` passes these on every launch; a
 * person who passes one alongside a prompt gets the safe inert default.
 * Keep in sync with the claude-compatible flags block in bin/bike4mind-cli.mjs.
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

export type EndpointPickerGateInput = {
  endpointSource: 'custom' | 'baked-default' | 'dev-default' | 'unconfigured';
  endpointChosen: boolean;
  hasAuthTokens: boolean;
};

/**
 * Whether to show the first-run backend picker: always when no endpoint resolves, and on a
 * fresh install of a build with a baked default (nothing chosen yet, nothing signed in).
 */
export function shouldShowEndpointPicker(input: EndpointPickerGateInput): boolean {
  if (input.endpointSource === 'unconfigured') return true;
  return input.endpointSource === 'baked-default' && !input.endpointChosen && !input.hasAuthTokens;
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

/**
 * The one-line notice printed when a host launch leaves an untrusted folder's config inert. The path
 * is escaped like the trust prompt it replaces, since a directory name can carry control bytes.
 */
export function hostInertNotice(projectRoot: string): string {
  // escapeTerminalControlChars leaves \n and \r alone; fold them so the notice stays on one line.
  const root = escapeTerminalControlChars(projectRoot).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return (
    `Project config in ${root} stays inert this session (host launch with a queued prompt; no trust prompt shown). ` +
    'Use /trust folder to trust it later.'
  );
}
