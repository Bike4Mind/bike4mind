import { connect as connectSocket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { DAEMON_OUTPUT_FILE_NAME } from './daemonOutput';
import { daemonPaths, inspectDaemon, readLockRecord, socketAccepts, type DaemonPaths } from './daemonFiles';
import { HOST_EXIT_CODES, type HostExitCode } from './exitCodes';
import type { HostLogger } from './logging';

export const DAEMON_START_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;

export type ConnectOptions = {
  dataDirectory: string;
  version: string;
  stdin: Readable;
  stdout: Writable;
  logger: HostLogger;
  /** Starts a daemon detached from this process; called only when none is running or starting. */
  spawnDaemon(): void;
  startTimeoutMs?: number;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Resolves true once the socket answers, false when `timeoutMs` passes first. */
async function waitForSocket(paths: DaemonPaths, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketAccepts(paths.socket)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * `b4m-host connect`: bridges stdin and stdout to the daemon's socket byte for byte, starting
 * the daemon first if none is running. stdout carries only what the daemon sends; everything
 * this command says goes to the logger (stderr). Ending stdin, or stdout closing, ends the
 * bridge and leaves the daemon running.
 */
export async function runConnect(options: ConnectOptions): Promise<HostExitCode> {
  const { logger, version } = options;
  const paths = daemonPaths(options.dataDirectory);
  const timeoutMs = options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS;

  const before = await inspectDaemon(paths);
  if (before.state === 'stopped' || before.state === 'stale') {
    logger.debug('HOST: no daemon running; starting one');
    options.spawnDaemon();
  }
  if (before.state !== 'running' && !(await waitForSocket(paths, timeoutMs))) {
    logger.error(
      `b4m-host: the daemon did not start within ${timeoutMs / 1000}s; see host.log and ${DAEMON_OUTPUT_FILE_NAME} in ${paths.directory}`
    );
    return HOST_EXIT_CODES.daemonStartTimeout;
  }

  const record = await readLockRecord(paths);
  if (record?.version !== version) {
    logger.error(
      `b4m-host: the running daemon is version ${record?.version ?? 'unknown'} (pid ${record?.pid ?? 'unknown'}) and this is ${version}; stop it with "b4m-host stop" to use this one`
    );
    return HOST_EXIT_CODES.daemonVersionMismatch;
  }
  return bridge(paths, options);
}

function bridge(paths: DaemonPaths, options: ConnectOptions): Promise<HostExitCode> {
  const { stdin, stdout, logger } = options;
  return new Promise(resolve => {
    const socket = connectSocket(paths.socket);
    let inputEnded = false;
    let settled = false;
    const finish = (code: HostExitCode) => {
      if (settled) return;
      settled = true;
      stdin.unpipe(socket);
      socket.unpipe(stdout);
      stdin.pause();
      socket.destroy();
      resolve(code);
    };

    stdin.once('end', () => {
      inputEnded = true;
      socket.end();
    });
    stdout.once('error', error => {
      logger.debug(`HOST: stdout closed: ${error.message}`);
      finish(HOST_EXIT_CODES.ok);
    });
    stdout.once('close', () => finish(HOST_EXIT_CODES.ok));
    socket.once('error', error => {
      logger.error(`b4m-host: lost the daemon connection: ${error.message}`);
      finish(HOST_EXIT_CODES.daemonConnectionLost);
    });
    socket.once('close', () => finish(inputEnded ? HOST_EXIT_CODES.ok : HOST_EXIT_CODES.daemonConnectionLost));
    socket.once('connect', () => {
      stdin.pipe(socket);
      socket.pipe(stdout, { end: false });
    });
  });
}
