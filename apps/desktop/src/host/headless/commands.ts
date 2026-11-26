import { connect } from 'node:net';
import {
  createHostFrameDecoder,
  encodeHostFrame,
  hostMethods,
  hostRequest,
  isHostResponse,
  type HostResult,
} from '@shared/hostProtocol';
import { daemonPaths, inspectDaemon, isProcessAlive, type DaemonPaths } from './daemonFiles';
import { HOST_EXIT_CODES, type HostExitCode } from './exitCodes';
import type { HostLogger } from './logging';

const STOP_TIMEOUT_MS = 15_000;
const INFO_TIMEOUT_MS = 5_000;

export type HostStatus =
  | { running: false }
  | {
      running: true;
      pid: number | null;
      version: string | null;
      starting: boolean;
      account: HostResult<'host/info'>['account'];
    };

/** One `host/info` over the socket; null when the daemon does not answer in time. */
function requestInfo(paths: DaemonPaths): Promise<HostResult<'host/info'> | null> {
  return new Promise(resolve => {
    const socket = connect(paths.socket);
    const decoder = createHostFrameDecoder();
    const finish = (info: HostResult<'host/info'> | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(info);
    };
    const timer = setTimeout(() => finish(null), INFO_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(null));
    socket.once('connect', () => socket.write(encodeHostFrame(hostRequest(1, 'host/info'))));
    socket.on('data', (chunk: string) => {
      for (const frame of decoder.push(chunk)) {
        if (!frame.ok) return finish(null);
        // Notifications the daemon broadcasts can arrive ahead of the answer.
        if (!isHostResponse(frame.message) || frame.message.id !== 1) continue;
        if (!('result' in frame.message)) return finish(null);
        const parsed = hostMethods['host/info'].result.safeParse(frame.message.result);
        return finish(parsed.success ? parsed.data : null);
      }
    });
  });
}

export async function readHostStatus(dataDirectory: string): Promise<HostStatus> {
  const paths = daemonPaths(dataDirectory);
  const state = await inspectDaemon(paths);
  if (state.state === 'stopped' || state.state === 'stale') return { running: false };
  const info = state.state === 'running' ? await requestInfo(paths) : null;
  return {
    running: true,
    pid: state.record?.pid ?? null,
    version: state.record?.version ?? null,
    starting: state.state === 'starting',
    account: info?.account ?? null,
  };
}

export function formatHostStatus(status: HostStatus): string {
  if (!status.running) return 'b4m-host daemon: not running';
  const account = status.account ? `${status.account.userId} on ${status.account.environmentUrl}` : 'not signed in';
  return [
    `b4m-host daemon: ${status.starting ? 'starting' : 'running'}`,
    `  pid:     ${status.pid ?? 'unknown'}`,
    `  version: ${status.version ?? 'unknown'}`,
    `  account: ${account}`,
  ].join('\n');
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Sends SIGTERM to a live daemon and waits for it to release the lock. */
export async function stopDaemon(dataDirectory: string, logger: HostLogger): Promise<HostExitCode> {
  const paths = daemonPaths(dataDirectory);
  const state = await inspectDaemon(paths);
  if (state.state === 'stopped' || state.state === 'stale') {
    logger.warn('b4m-host: no daemon is running');
    return HOST_EXIT_CODES.ok;
  }
  const pid = state.record?.pid;
  if (!pid) {
    logger.error(`b4m-host: ${paths.lock} names no process to stop`);
    return HOST_EXIT_CODES.failure;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // It exited between the inspection and the signal: already stopped.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return HOST_EXIT_CODES.ok;
    throw err;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid) || (await inspectDaemon(paths)).state === 'stopped') return HOST_EXIT_CODES.ok;
    await delay(100);
  }
  logger.error(`b4m-host: the daemon (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000}s`);
  return HOST_EXIT_CODES.failure;
}
