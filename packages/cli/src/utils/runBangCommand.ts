import { spawn, type ChildProcess } from 'child_process';

/** How long a `!command` may run before it is killed (ms). */
export const BANG_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const BANG_COMMAND_MAX_OUTPUT_CHARS = 10 * 1024 * 1024;

// Process groups are a POSIX concept; on Windows only the shell itself can be signalled.
const USE_PROCESS_GROUP = process.platform !== 'win32';

export type BangCommandResult = { output: string; isError: boolean };

const runningCommands = new Set<ChildProcess>();

/** Signal the command's whole process tree, so `make && ./server` does not outlive a kill. */
function killCommand(child: ChildProcess): void {
  try {
    if (USE_PROCESS_GROUP && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // ESRCH: already exited.
  }
}

/** Kills every `!command` still running; called on CLI exit so none is orphaned. */
export function killRunningBangCommands(): void {
  for (const child of runningCommands) {
    killCommand(child);
  }
  runningCommands.clear();
}

/**
 * Runs a `!command` typed in the TUI without blocking the event loop, through the platform shell
 * like the execSync it replaces. Never rejects: every failure comes back as `isError` output.
 */
export function runBangCommand(
  command: string,
  { cwd, timeoutMs = BANG_COMMAND_TIMEOUT_MS, signal }: { cwd: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<BangCommandResult> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command, { cwd, shell: true, detached: USE_PROCESS_GROUP, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ output: error instanceof Error ? error.message : String(error), isError: true });
      return;
    }
    runningCommands.add(child);

    let stdout = '';
    let stderr = '';
    let failure: 'timeout' | 'overflow' | 'cancelled' | null = null;

    const stop = (reason: 'timeout' | 'overflow' | 'cancelled') => {
      failure ??= reason;
      killCommand(child);
    };
    const collect = (append: (text: string) => void) => (text: string) => {
      // Past a timeout or the cap, keep draining the pipe but stop growing the buffer.
      if (failure) return;
      append(text);
      if (stdout.length + stderr.length > BANG_COMMAND_MAX_OUTPUT_CHARS) stop('overflow');
    };
    // setEncoding decodes through a StringDecoder, so a multi-byte character split across two
    // pipe chunks is not mangled.
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on(
      'data',
      collect(text => (stdout += text))
    );
    child.stderr?.on(
      'data',
      collect(text => (stderr += text))
    );

    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const cancel = () => stop('cancelled');
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, { once: true });

    const finish = (result: BangCommandResult) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      runningCommands.delete(child);
      resolve(result);
    };

    child.on('error', error => finish({ output: error.message, isError: true }));
    child.on('close', code => {
      if (failure === 'timeout') {
        const partial = stdout ? `${stdout.trimEnd()}\n` : '';
        finish({ output: `${partial}Command timed out after ${Math.round(timeoutMs / 1000)}s`, isError: true });
      } else if (failure === 'cancelled') {
        finish({ output: 'Command cancelled', isError: true });
      } else if (failure === 'overflow') {
        finish({ output: `Command output exceeded ${BANG_COMMAND_MAX_OUTPUT_CHARS / 1024 / 1024} MB`, isError: true });
      } else if (code === 0) {
        finish({ output: stdout, isError: false });
      } else {
        // stdout too: `diff` and `git diff --exit-code` report through it on a non-zero exit.
        finish({ output: stderr || stdout || `Command failed: ${command}`, isError: true });
      }
    });
  });
}
