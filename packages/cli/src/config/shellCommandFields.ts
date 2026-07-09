/**
 * Shell-like tools whose free-text command argument must be run through the
 * command-risk classifier before a permission decision. Maps tool name -> the
 * arg field holding the command string. `bash_execute` is the only shell-exec
 * tool today; any new one (e.g. `shell_execute`, an MCP `run_shell`, a code-exec
 * tool) MUST be added here or it will silently skip the classifier and can
 * auto-run destructive strings.
 *
 * Single source of truth for BOTH permission gates:
 * - the interactive/host gate (utils/toolsAdapter.ts), and
 * - the headless protocol's risk classifier (commands/headlessProtocol.ts).
 */
export const SHELL_LIKE_TOOL_COMMAND_FIELDS: Record<string, string> = {
  bash_execute: 'command',
};
