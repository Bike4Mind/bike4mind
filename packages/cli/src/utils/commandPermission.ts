import type { PermissionManager } from './PermissionManager';
import type { PermissionResponse } from '../components/PermissionPrompt';
import { classifyCommandRisk } from '../config/commandRisk';

/** Prompt function shape shared with the tool-permission and orchestrator paths. */
export type ShellPermissionPromptFn = (
  toolName: string,
  args: unknown,
  preview?: string
) => Promise<{ action: PermissionResponse }>;

/**
 * The permission collaborators a hook path threads through so its shell command
 * can be classified and prompted before it runs. Optional at every hook call
 * site: when present the command is gated; when absent (e.g. a unit test that
 * exercises hook dispatch directly) the legacy unguarded behavior is kept.
 * Every PRODUCTION call site supplies this, which is what makes the gate hold.
 */
export interface ShellCommandPermissionDeps {
  permissionManager: PermissionManager;
  promptFn: ShellPermissionPromptFn;
}

export interface ShellCommandPermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Gate a hook's shell command through the same permission path as bash_execute,
 * BEFORE the command runs. Hooks are prompt_always-equivalent: they may be
 * allowed once or for the session, but never permanently trusted. Trusting the
 * project folder loads the hook definitions; it does not pre-authorize the shell
 * commands they carry.
 */
export async function requestShellCommandPermission(
  toolName: string,
  command: string,
  cwd: string,
  deps: ShellCommandPermissionDeps
): Promise<ShellCommandPermissionResult> {
  const { permissionManager, promptFn } = deps;

  // Session-trusted (an earlier allow-session this run) skips the prompt. The
  // hook toolName is namespaced and never permanently trusted, so this only ever
  // returns false-to-prompt or true-because-session-trusted.
  if (!permissionManager.needsPermission(toolName)) {
    return { allowed: true };
  }

  const risk = classifyCommandRisk(command);
  const reasons = risk.reasons.length ? `\nReasons: ${risk.reasons.join('; ')}` : '';
  const preview = `Hook shell command [${risk.level} risk] in ${cwd}:\n${command}${reasons}`;

  const { action } = await promptFn(toolName, { command, cwd }, preview);

  switch (action) {
    case 'allow-session':
      permissionManager.trustToolForSession(toolName);
      return { allowed: true };
    case 'allow-once':
    // A hook can't be permanently trusted; 'allow-always' behaves as 'allow-once'.
    case 'allow-always':
      return { allowed: true };
    case 'deny':
    default:
      return { allowed: false, reason: 'Hook command denied by user' };
  }
}
