import { rmSync, realpathSync } from 'fs';
import path from 'path';
import { isPathAllowed } from '@bike4mind/services/llm/tools/cliTools';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import type { ToolArgs } from '../gatewayTypes.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import { sandboxedCommandArg } from '../toolPolicy.js';
import { sanitizeTerminalText } from '../../../utils/sanitizeTerminalText.js';

/** How the sandbox pre-step leaves a call: refused, rewritten to run sandboxed, or untouched. */
export type SandboxPreparation =
  | { kind: 'blocked'; message: string }
  | { kind: 'sandboxed'; args: ToolArgs; cleanupPaths: string[] | undefined }
  | { kind: 'unchanged' };

/**
 * Decide whether a call runs inside the OS sandbox, and rewrite its args to do so. Only a tool
 * whose descriptor declares `sandbox` is wrapped; any other tool, or a call with no command or
 * no orchestrator, is left unchanged.
 */
export function prepareSandbox(
  descriptor: ToolDescriptor | undefined,
  args: ToolArgs | undefined,
  sandboxOrchestrator: SandboxOrchestrator | undefined,
  allowedDirectories: string[] | undefined
): SandboxPreparation {
  const commandArg = sandboxedCommandArg(descriptor);
  if (!commandArg || !args || !sandboxOrchestrator) return { kind: 'unchanged' };
  const command = args[commandArg];
  if (typeof command !== 'string' || !command) return { kind: 'unchanged' };

  let cwd = args.cwd ? path.resolve(process.cwd(), args.cwd as string) : process.cwd();
  // Resolve symlinks up front so the confinement check (isPathAllowed resolves
  // internally) and the sandbox's writable bind (built from the string we pass)
  // use the SAME real path - otherwise a symlinked cwd could validate while the
  // bind points elsewhere.
  try {
    cwd = realpathSync(cwd);
  } catch {
    // Not-yet-resolvable path: keep the lexical resolution.
  }
  const decision = sandboxOrchestrator.shouldSandbox(command, cwd, workingDirectory => {
    if (isPathAllowed(workingDirectory, allowedDirectories).allowed) return undefined;
    return (
      `working directory ${workingDirectory} is outside the sandbox writable root ` +
      `(grant it with '/add-dir ${workingDirectory}' or run from within the workspace)`
    );
  });

  if (decision.type === 'blocked') {
    return { kind: 'blocked', message: blockCommand(sandboxOrchestrator, command, decision.reason) };
  }

  if (decision.type === 'sandbox') {
    // Defensive check for alternate orchestrators that do not invoke the pre-wrap validator.
    if (!isPathAllowed(cwd, allowedDirectories).allowed) {
      cleanupSandboxFiles(decision.wrappedCommand.cleanupPaths);
      return {
        kind: 'blocked',
        message: blockCommand(
          sandboxOrchestrator,
          command,
          `working directory ${cwd} is outside the sandbox writable root ` +
            `(grant it with '/add-dir ${cwd}' or run from within the workspace)`
        ),
      };
    }
    sandboxOrchestrator.recordSandboxed();
    const cleanupPaths = decision.wrappedCommand.cleanupPaths;
    return {
      kind: 'sandboxed',
      cleanupPaths,
      args: {
        ...args,
        // Hand execution the SAME realpath-resolved cwd used for the confinement
        // check and the writable bind. Bubblewrap bakes --chdir into its command,
        // but Seatbelt's process cwd is whatever spawn() sets, so without this the
        // sandboxed process would run in the unresolved (symlinked) path - a silent
        // divergence from the profile's baked writable root.
        cwd,
        [commandArg]: decision.wrappedCommand.commandString,
      },
    };
  }

  sandboxOrchestrator.recordUnsandboxed();
  return { kind: 'unchanged' };
}

/** Record + report a blocked command and return the model-facing message. */
function blockCommand(sandboxOrchestrator: SandboxOrchestrator, command: string, reason: string): string {
  sandboxOrchestrator.recordBlocked();
  sandboxOrchestrator
    .recordViolation({
      type: 'filesystem',
      command,
      blockedBy: 'config',
      timestamp: new Date(),
      detail: reason,
    })
    .catch(() => {});
  console.error(
    `\n\x1b[41m\x1b[97m BLOCKED \x1b[0m \x1b[31mSandbox denied this command:\x1b[0m ${sanitizeTerminalText(reason)}\n`
  );
  return `Command blocked by sandbox: ${reason}`;
}

/**
 * Clean up temporary sandbox files (e.g., Seatbelt profiles).
 * Fails silently - cleanup is best-effort.
 */
export function cleanupSandboxFiles(paths?: string[]): void {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Parse sandbox runtime stderr for violations and record them.
 * Fire-and-forget - errors are silently swallowed.
 */
export async function captureViolations(
  isSandboxed: boolean,
  result: string,
  command: string | undefined,
  orchestrator?: SandboxOrchestrator
): Promise<void> {
  if (!isSandboxed || !orchestrator || !command) return;
  const { parseSandboxStderr, toSandboxViolations } = await import('../../../sandbox/logging/StderrViolationParser.js');
  const parsed = parseSandboxStderr(result);
  if (parsed.length > 0) {
    const violations = toSandboxViolations(parsed, command);
    for (const v of violations) {
      await orchestrator.recordViolation(v).catch(() => {});
    }
  }
}
