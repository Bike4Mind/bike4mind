import { spawn } from 'node:child_process';
import { STDERR_TAIL_LENGTH, type ProcessSpec } from '../processTransport';

export type RemoteScriptOptions = {
  /** Each complete line the script prints on stdout, as it arrives. */
  onLine?(line: string): void;
  /** After each chunk of the script reaches ssh's stdin, in bytes. */
  onSent?(sentBytes: number, totalBytes: number): void;
  /** Kills the run after this long, in ms. */
  timeoutMs: number;
};

export type RemoteScriptResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Every stdout line, in order. */
  lines: string[];
  stderrTail: string;
  timedOut: boolean;
};

/** How much of the script is written to ssh before waiting for it to drain, in bytes. */
const CHUNK_BYTES = 64 * 1024;
/** After the process exits, how long its stdout and stderr may take to drain, in ms (see processTransport.ts). */
const DRAIN_AFTER_EXIT_MS = 250;
const KILL_GRACE_MS = 2_000;

/**
 * Runs `script` through `spec` (`ssh <alias> -- sh -s`, or `sh -s` in tests) by writing it to
 * stdin, and resolves when the process ends, whatever its exit. Rejects only when the process
 * cannot be started.
 */
export function runRemoteScript(
  spec: ProcessSpec,
  script: string,
  options: RemoteScriptOptions
): Promise<RemoteScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines: string[] = [];
    let partial = '';
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }, options.timeoutMs);

    const takeLine = (line: string) => {
      lines.push(line);
      options.onLine?.(line);
    };

    const settle = () => {
      if (settled || !exited) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      if (partial !== '') takeLine(partial);
      resolve({ code: exited.code, signal: exited.signal, lines, stderrTail, timedOut });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const line of parts) takeLine(line);
    });
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LENGTH);
    });
    // A script cut short by the process ending fails with EPIPE; the exit says why.
    child.stdin.on('error', () => undefined);

    child.once('error', error => {
      if (exited || settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      drainTimer = setTimeout(settle, DRAIN_AFTER_EXIT_MS);
    });
    child.once('close', settle);

    child.once('spawn', () => {
      void writeScript(child.stdin, script, options.onSent);
    });
  });
}

async function writeScript(
  stdin: NodeJS.WritableStream,
  script: string,
  onSent: RemoteScriptOptions['onSent']
): Promise<void> {
  const bytes = Buffer.from(script, 'utf8');
  let sent = 0;
  while (sent < bytes.length) {
    const chunk = bytes.subarray(sent, sent + CHUNK_BYTES);
    const flowing = stdin.write(chunk);
    sent += chunk.length;
    onSent?.(sent, bytes.length);
    if (!flowing) {
      const drained = await new Promise<boolean>(resolve => {
        const onDrain = () => {
          stdin.off('close', onClose);
          resolve(true);
        };
        const onClose = () => {
          stdin.off('drain', onDrain);
          resolve(false);
        };
        stdin.once('drain', onDrain);
        stdin.once('close', onClose);
      });
      if (!drained) return;
    }
  }
  stdin.end();
}
