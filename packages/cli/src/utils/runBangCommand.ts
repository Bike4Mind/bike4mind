import { exec } from 'child_process';

/** How long a `!command` may run before it is killed (ms). */
export const BANG_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const BANG_COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export type BangCommandResult = { output: string; isError: boolean };

type ExecFailure = Error & { stdout?: string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null };

/**
 * Runs a `!command` typed in the TUI without blocking the event loop, so the UI keeps rendering
 * while it runs. Uses the platform shell, like the execSync it replaces.
 */
export function runBangCommand(
  command: string,
  { cwd, timeoutMs = BANG_COMMAND_TIMEOUT_MS }: { cwd: string; timeoutMs?: number }
): Promise<BangCommandResult> {
  return new Promise(resolve => {
    const child = exec(
      command,
      { cwd, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: BANG_COMMAND_MAX_BUFFER },
      (error: ExecFailure | null, stdout, stderr) => {
        if (!error) {
          resolve({ output: stdout, isError: false });
          return;
        }
        if (error.killed && error.signal) {
          const partial = stdout ? `${stdout.trimEnd()}\n` : '';
          resolve({ output: `${partial}Command timed out after ${Math.round(timeoutMs / 1000)}s`, isError: true });
          return;
        }
        resolve({ output: stderr || error.message || 'Command failed', isError: true });
      }
    );
    // Nothing is ever typed into the command, so close stdin: a command that reads it (`cat`)
    // would otherwise wait until the timeout.
    child.stdin?.end();
  });
}
