import { spawn } from 'child_process';

export interface ShellRunnerOptions {
  /** Shell command to execute */
  command: string;
  /** Working directory */
  cwd: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Environment variables (merged with process.env by caller) */
  env?: Record<string, string | undefined>;
  /** Optional data to pipe to stdin */
  stdin?: string;
}

export interface ShellRunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Execute a shell command with timeout, stdout/stderr capture, and optional stdin.
 *
 * Returns raw results without interpreting exit codes or output format -
 * callers are responsible for mapping results to their domain-specific types.
 */
export async function runShellCommand(options: ShellRunnerOptions): Promise<ShellRunnerResult> {
  const { command, cwd, timeoutMs, env, stdin } = options;

  return new Promise(resolve => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', data => {
      stdout += data;
    });

    child.stderr.on('data', data => {
      stderr += data;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });

    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: error.message, timedOut: false });
    });

    // A child that never reads stdin (e.g. `rm -f`) can close its read end and
    // exit before we finish writing. The pending write then rejects with EPIPE,
    // emitted asynchronously on the stdin stream. Without this handler Node
    // escalates it to an unhandled exception that crashes the worker. Treat
    // EPIPE as a benign "consumer went away"; re-surface anything else.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: error.message, timedOut: false });
      }
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}
