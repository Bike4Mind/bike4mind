import { spawnSync } from 'node:child_process';

export interface RunResult {
  /** Null when the process could not be started, timed out or was killed by a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
}

/** Runs one program by absolute path, with no shell, and waits for it. */
export type ProcessRunner = (file: string, args: readonly string[], options?: RunOptions) => RunResult;

export const runProcess: ProcessRunner = (file, args, { input, timeoutMs = 30_000 } = {}) => {
  const result = spawnSync(file, args, {
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};
