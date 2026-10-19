import { rmSync, realpathSync } from 'fs';
import path from 'path';
import { isPathAllowed } from '@bike4mind/services/llm/tools/cliTools';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import type { ToolArgs } from '../gatewayTypes.js';

/** How the sandbox pre-step leaves a call: refused, rewritten to run sandboxed, or untouched. */
export type SandboxPreparation =
  | { kind: 'blocked'; message: string }
  | { kind: 'sandboxed'; args: ToolArgs; cleanupPaths: string[] | undefined }
  | { kind: 'unchanged' };

/**
 * Decide whether a bash_execute call runs inside the OS sandbox, and rewrite its args to do so.
 * Any other tool, or a call with no command or no orchestrator, is left unchanged.
 */
export function prepareSandbox(
  toolName: string,
  args: ToolArgs | undefined,
  sandboxOrchestrator: SandboxOrchestrator | undefined,
  allowedDirectories: string[] | undefined
): SandboxPreparation {
  if (toolName !== 'bash_execute' || !args?.command || !sandboxOrchestrator) return { kind: 'unchanged' };
  const command = args.command as string;

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
  const decision = sandboxOrchestrator.shouldSandbox(command, cwd);

  if (decision.type === 'blocked') {
    return { kind: 'blocked', message: blockCommand(sandboxOrchestrator, command, decision.reason) };
  }

  if (decision.type === 'sandbox') {
    // Confine the writable root to the same allow-list the core file tools
    // honor. A model-supplied cwd outside the workspace would otherwise
    // become the sandbox's read-write bind; reject it (and drop the temp
    // sandbox profile shouldSandbox already built) before it can execute.
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
        command: decision.wrappedCommand.commandString,
        _sandboxCleanup: cleanupPaths,
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
  console.error(`\n\x1b[41m\x1b[97m BLOCKED \x1b[0m \x1b[31mSandbox denied this command:\x1b[0m ${reason}\n`);
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
 * Detect whether a tool result indicates a sandbox-specific runtime failure
 * worth offering an unsandboxed retry for. Matches the sandbox markers
 * (`sandbox-exec:`, `bwrap:`) AND a bare "Operation not permitted": on macOS a
 * real Seatbelt denial is the denied syscall's own EPERM, printed by the tool
 * that hit it with NO `sandbox-exec:` prefix (that prefix only appears when the
 * profile fails to load) - a write denial reads `touch: <path>: Operation not
 * permitted`, and a blocked connect surfaces the same EPERM. Matching only the
 * markers would never fire for those, silently dropping the recovery offer and
 * the `/sandbox:network on` tip. The known false positive (e.g. `kill` on a
 * foreign pid) is accepted: it only costs a deniable retry prompt, whereas a
 * false negative removes the recovery path entirely.
 */
export function isSandboxFailure(isSandboxed: boolean, result: string): boolean {
  if (!isSandboxed) return false;
  return result.includes('sandbox-exec:') || result.includes('bwrap:') || result.includes('Operation not permitted');
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
