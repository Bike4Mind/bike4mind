import type { PermissionManager } from '../../../utils/PermissionManager.js';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import type { ShowKindedPermissionPrompt, ToolArgs } from '../gatewayTypes.js';
import { commandTextOf, sandboxedCommandArg } from '../toolPolicy.js';
import { assessCommandRisk } from './commandRisk.js';
import { captureViolations } from './sandbox.js';

export type SandboxDenial = {
  /** 'launcher': the sandbox runtime itself reported the failure. 'eperm': a denied syscall surfaced as EPERM. */
  reason: 'launcher' | 'eperm';
  snippet: string;
};

const SNIPPET_LENGTH = 200;
// The bash tool appends its own "Exit code: N" after stdout/stderr, so the last such line is
// the real one; an earlier match is command output.
const EXIT_CODE_LINE = /^Exit code:\s*(-?\d+)\s*$/gm;
// sandbox-exec and bwrap print their own failures at the start of a stderr line.
const LAUNCHER_MARKER = /^(?:sandbox-exec|bwrap):/m;
const EPERM_TEXT = 'Operation not permitted';

const NETWORK_TIP = "If this was a network call, prefer '/sandbox:network on' to allow filtered egress.";

/**
 * Detect a sandbox denial in a tool result. A launcher marker (`sandbox-exec:`, `bwrap:` at the
 * start of a line) suffices. On macOS a real Seatbelt denial is the denied syscall's own EPERM
 * with no marker, so "Operation not permitted" also counts, but only with a non-zero final
 * "Exit code:" line: a command that printed the phrase and still exited 0 (e.g. a tolerated
 * `kill`) was not stopped.
 */
export function detectSandboxDenial(sandboxed: boolean, result: string): SandboxDenial | null {
  if (!sandboxed) return null;
  const marker = LAUNCHER_MARKER.exec(result);
  if (marker) return { reason: 'launcher', snippet: snippetAt(result, marker.index) };
  const epermIndex = result.indexOf(EPERM_TEXT);
  if (epermIndex === -1) return null;
  const exitCodes = [...result.matchAll(EXIT_CODE_LINE)];
  const exitCode = exitCodes[exitCodes.length - 1]?.[1];
  if (exitCode === undefined || Number(exitCode) === 0) return null;
  return { reason: 'eperm', snippet: snippetAt(result, epermIndex) };
}

/** The error text from the start of the line holding `index`, so long stdout never hides it. */
function snippetAt(result: string, index: number): string {
  const lineStart = result.lastIndexOf('\n', index) + 1;
  return result.slice(lineStart, lineStart + SNIPPET_LENGTH);
}

/** A bash session (background, or promoted after yield_time_ms) may still be running. */
function isSessionRun(args: ToolArgs): boolean {
  return args.run_in_background === true || typeof args.yield_time_ms === 'number';
}

export type SandboxedRunInput = {
  toolName: string;
  descriptor: ToolDescriptor | undefined;
  /** The call's args as the model sent them. */
  rawArgs: ToolArgs | undefined;
  /** The args for the sandboxed attempt: the wrapped command and the resolved cwd. */
  execArgs: ToolArgs;
  isSandboxed: boolean;
  /** Runs the tool once with the given args. */
  attempt: (args: ToolArgs) => Promise<string>;
  permissionManager: PermissionManager;
  showPermissionPrompt: ShowKindedPermissionPrompt;
  sandboxOrchestrator?: SandboxOrchestrator;
};

/**
 * The sandbox stage of execution: run the attempt, record violations, and if the OS sandbox
 * denied it, ask before retrying outside the sandbox. The question is its own prompt: auto-accept,
 * session trust, trusted tools and the host allowlist never approve it, and when nobody can
 * answer, the model gets the sandbox error back. Session runs (background or yield_time_ms) are
 * never escalated: the sandboxed process may still be running.
 */
export async function runSandboxed(input: SandboxedRunInput): Promise<string> {
  const { descriptor, rawArgs, execArgs, isSandboxed, attempt, permissionManager, sandboxOrchestrator } = input;
  const result = await attempt(execArgs);
  await captureViolations(isSandboxed, result, commandTextOf(descriptor, rawArgs), sandboxOrchestrator);

  const commandArg = sandboxedCommandArg(descriptor);
  const command = commandTextOf(descriptor, rawArgs);
  if (!commandArg || command === undefined || isSessionRun(execArgs)) return result;
  const denial = detectSandboxDenial(isSandboxed, result);
  if (!denial) return result;

  if (sandboxOrchestrator?.getConfig().allowUnsandboxedCommands === false) {
    return `${result}\n\nThe command was denied by the OS sandbox and running it outside the sandbox is disabled. ${NETWORK_TIP}`;
  }

  const cwd = typeof execArgs.cwd === 'string' ? execArgs.cwd : process.cwd();
  const isHighRisk = assessCommandRisk(descriptor, rawArgs)?.level === 'high';
  const approvalKey = JSON.stringify([cwd, command]);

  if (isHighRisk || !permissionManager.isSandboxEscalationApproved(approvalKey)) {
    const response = await input.showPermissionPrompt(
      input.toolName,
      rawArgs,
      escalationPreview(denial),
      'sandbox-escalation'
    );
    if (response.action === 'deny') return `${result}\n\n${NETWORK_TIP}`;
    if (response.action === 'allow-session' && !isHighRisk) permissionManager.approveSandboxEscalation(approvalKey);
  }

  sandboxOrchestrator?.recordUnsandboxed();
  return attempt({ ...execArgs, [commandArg]: command, cwd });
}

function escalationPreview(denial: SandboxDenial): string {
  return (
    `\u{1F6D1} SANDBOX BLOCKED - This command was denied by the OS sandbox.\n\n` +
    `- The sandbox prevented this operation because it violates filesystem or network restrictions.\n` +
    `- ${NETWORK_TIP}\n` +
    `- You can retry without the sandbox, but the command will run with full system access.\n\n` +
    `@@Error Details@@\n${denial.snippet}`
  );
}
