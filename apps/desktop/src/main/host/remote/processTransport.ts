import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  HostConnectError,
  HostRequestError,
  createHostFrameDecoder,
  encodeHostFrame,
  hostRequest,
  isHostNotification,
  isHostResponse,
  type HostCloseReason,
  type HostConnectFailure,
  type HostConnectFailureKind,
  type HostNotification,
  type HostTransport,
} from '@shared/hostProtocol';
import { HOST_EXIT_CODES } from '../../../host/headless/exitCodes';

/** A program that speaks the host protocol on its stdin and stdout, such as `ssh <alias> b4m-host connect`. */
export type ProcessSpec = {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Names the host in failure messages, e.g. the SSH alias. */
  label: string;
};

export type ProcessTransport = HostTransport & {
  /** The child's pid, for diagnostics and tests. */
  readonly pid: number | undefined;
};

export type ProcessTransportOptions = {
  /** A line on stdout that is not a host message, or a message no request waits for. */
  onProtocolError?(detail: string): void;
  spawnProcess?: typeof spawn;
};

/** In characters of decoded text; enough for ssh's and b4m-host's last messages. */
export const STDERR_TAIL_LENGTH = 8 * 1024;

/** After the child exits, how long stdout and stderr may take to drain before the close is reported, in ms. */
const DRAIN_AFTER_EXIT_MS = 250;
/** After close() asks the child to stop, how long before it is killed outright, in ms. */
const KILL_GRACE_MS = 2_000;

/** POSIX shells exit 127 for a command they cannot find, 126 for one they cannot execute. */
const SHELL_NOT_FOUND = 127;
const SHELL_NOT_EXECUTABLE = 126;
/** ssh exits 255 for its own errors: unreachable, refused, authentication, host key. */
const SSH_ERROR = 255;

const KIND_FOR_EXIT_CODE: ReadonlyMap<number, HostConnectFailureKind> = new Map([
  [HOST_EXIT_CODES.unsupportedPlatform, 'unsupportedPlatform'],
  [HOST_EXIT_CODES.nodeTooOld, 'nodeTooOld'],
  [HOST_EXIT_CODES.nodeMissing, 'nodeMissing'],
  [HOST_EXIT_CODES.daemonVersionMismatch, 'daemonVersionMismatch'],
  [HOST_EXIT_CODES.daemonStartTimeout, 'daemonStartTimeout'],
  [HOST_EXIT_CODES.daemonAlreadyRunning, 'lost'],
  [HOST_EXIT_CODES.daemonConnectionLost, 'lost'],
  [SHELL_NOT_EXECUTABLE, 'notInstalled'],
  [SHELL_NOT_FOUND, 'notInstalled'],
  [SSH_ERROR, 'sshFailed'],
]);

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .pop() ?? '';

const DEFAULT_DETAIL: Record<HostConnectFailureKind, (label: string) => string> = {
  sshFailed: label => `Could not connect to ${label} over SSH`,
  notInstalled: label => `The Bike4Mind host program is not installed on ${label}`,
  nodeMissing: label => `Node.js was not found on ${label}`,
  nodeTooOld: label => `Node.js on ${label} is too old for the Bike4Mind host program`,
  unsupportedPlatform: label => `The Bike4Mind host program does not run on ${label}'s operating system`,
  daemonStartTimeout: label => `The Bike4Mind host on ${label} did not start in time`,
  daemonVersionMismatch: label => `Another version of the Bike4Mind host is running on ${label}`,
  protocolMismatch: label => `${label} speaks another version of the host protocol`,
  lost: label => `The connection to ${label} ended`,
};

/**
 * What an exit means for the user. ssh's own message is the detail for an SSH failure, since it
 * says what to fix (host key, authentication, DNS); otherwise the detail names the kind and the
 * stderr tail carries the rest.
 */
export function failureForExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
  label: string
): HostConnectFailure {
  const kind = (code === null ? undefined : KIND_FOR_EXIT_CODE.get(code)) ?? 'lost';
  const how = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
  const sshMessage = kind === 'sshFailed' ? lastLine(stderrTail) : '';
  const detail = sshMessage === '' ? `${DEFAULT_DETAIL[kind](label)} (exit ${how})` : sshMessage;
  return { kind, detail, stderrTail };
}

type Pending = { method: string; resolve(result: unknown): void; reject(error: unknown): void };

/**
 * A host transport over a child process's stdio, one ndjson frame per line. Resolves once the
 * child has started; rejects with HostConnectError when it cannot be started (the program is
 * missing, for one). When the child exits, every pending request rejects with the failure its
 * exit code means (HostConnectError) and the close listeners hear the same failure, so a host
 * that is not installed reads as `notInstalled` rather than as a broken connection.
 */
export function createProcessTransport(
  spec: ProcessSpec,
  options: ProcessTransportOptions = {}
): Promise<ProcessTransport> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const reportProtocolError = options.onProtocolError ?? (() => undefined);

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(spec.command, [...spec.args], {
        env: spec.env,
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnFailure(spec, error));
      return;
    }

    const pending = new Map<number, Pending>();
    const listeners = new Set<(notification: HostNotification) => void>();
    const closeListeners = new Set<(reason: HostCloseReason) => void>();
    const decoder = createHostFrameDecoder();
    let stderr = '';
    let nextId = 1;
    let started = false;
    let ended = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (reason: HostCloseReason, error: HostConnectError) => {
      if (ended) return;
      ended = true;
      const waiting = [...pending.values()];
      pending.clear();
      for (const entry of waiting) entry.reject(error);
      listeners.clear();
      const notify = [...closeListeners];
      closeListeners.clear();
      for (const listener of notify) listener(reason);
    };

    const deliver = (chunk: string) => {
      if (ended) return;
      for (const frame of decoder.push(chunk)) {
        if (!frame.ok) {
          reportProtocolError(`${spec.label}: ${frame.error.message}`);
          continue;
        }
        const { message } = frame;
        if (isHostNotification(message)) {
          for (const listener of listeners) listener(message);
          continue;
        }
        const id = isHostResponse(message) && typeof message.id === 'number' ? message.id : null;
        const entry = id === null ? undefined : pending.get(id);
        if (id === null || !entry || !isHostResponse(message)) {
          reportProtocolError(`${spec.label}: a message no request waits for`);
          continue;
        }
        pending.delete(id);
        if ('error' in message) entry.reject(new HostRequestError(message.error));
        else entry.resolve(message.result);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', deliver);
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_LENGTH);
    });
    // A write after the child is gone fails with EPIPE; the exit reports the real reason.
    child.stdin.on('error', () => undefined);

    // `exit` can come before stdio has drained, and an ssh that starts a ControlPersist master
    // may leave stderr open in that master, so `close` alone could wait for a minute.
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const settleExit = () => {
      clearTimeout(drainTimer);
      clearTimeout(killTimer);
      if (!exited) return;
      const failure = failureForExit(exited.code, exited.signal, stderr, spec.label);
      finish({ initiator: 'host', failure }, new HostConnectError(failure));
    };
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      drainTimer = setTimeout(settleExit, DRAIN_AFTER_EXIT_MS);
    });
    child.once('close', settleExit);

    child.once('error', error => {
      if (!started) {
        ended = true;
        reject(spawnFailure(spec, error));
        return;
      }
      const failure: HostConnectFailure = { kind: 'lost', detail: error.message, stderrTail: stderr };
      finish({ initiator: 'host', failure }, new HostConnectError(failure));
    });

    const transport: ProcessTransport = {
      get pid() {
        return child.pid;
      },
      request(method, params) {
        if (ended) {
          return Promise.reject(
            new HostConnectError({
              kind: 'lost',
              detail: `The connection to ${spec.label} is closed; ${method} was not sent`,
              stderrTail: stderr,
            })
          );
        }
        const id = nextId++;
        return new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
          child.stdin.write(encodeHostFrame(hostRequest(id, method, params)));
        });
      },
      onNotification(listener) {
        if (ended) return () => undefined;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(listener) {
        if (ended) return () => undefined;
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close() {
        if (ended) return;
        finish(
          { initiator: 'client' },
          new HostConnectError({ kind: 'lost', detail: `The connection to ${spec.label} was closed`, stderrTail: '' })
        );
        // Ending stdin lets `b4m-host connect` leave the daemon cleanly; the signal covers a child that hangs.
        child.stdin.end();
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
      },
    };

    child.once('spawn', () => {
      started = true;
      resolve(transport);
    });
  });
}

function spawnFailure(spec: ProcessSpec, error: unknown): HostConnectError {
  const message = error instanceof Error ? error.message : String(error);
  return new HostConnectError({
    kind: 'sshFailed',
    detail: `Could not start ${spec.command} to reach ${spec.label}: ${message}`,
    stderrTail: '',
  });
}
