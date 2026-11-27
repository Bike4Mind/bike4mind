import { join } from 'node:path';
import { ensurePrivateDirectory } from '../auth/privateDirectory';
import { composeHeadlessHost } from './composeHeadlessHost';
import { startDaemon } from './daemon';
import { DaemonAlreadyRunningError } from './daemonFiles';
import { HOST_EXIT_CODES, type HostExitCode } from './exitCodes';
import { createFileLogger, createStderrLogger, LOG_FILE_NAME } from './logging';

export type DaemonProcessOptions = {
  dataDirectory: string;
  homeDirectory: string;
  version: string;
  verbose: boolean;
};

/**
 * `b4m-host daemon`: runs the daemon in this process until SIGTERM or SIGINT, logging to
 * `host.log` in the data directory. Resolves with the exit code once it has shut down.
 */
export async function runDaemonProcess(options: DaemonProcessOptions): Promise<HostExitCode> {
  const { dataDirectory, homeDirectory, version, verbose } = options;
  await ensurePrivateDirectory(dataDirectory);
  const logger = createFileLogger({ path: join(dataDirectory, LOG_FILE_NAME), verbose });

  // Matches Desktop's main process: a stray rejection is logged rather than taking every session down.
  process.on('unhandledRejection', reason => logger.error('HOST: unhandled rejection', reason));
  process.on('uncaughtException', error => {
    logger.error('HOST: uncaught exception; exiting', error);
    process.exit(HOST_EXIT_CODES.failure);
  });

  // Installed before the start: the socket answers while the host composes, so `stop` can
  // signal then, and the shutdown runs once the daemon is up.
  let received: NodeJS.Signals | null = null;
  let stop: (() => void) | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    if (received) return;
    received = signal;
    logger.warn(`HOST: received ${signal}`);
    stop?.();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  let daemon;
  try {
    daemon = await startDaemon({
      dataDirectory,
      version,
      logger,
      compose: () => composeHeadlessHost({ dataDirectory, homeDirectory, version, logger }),
    });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      createStderrLogger(verbose).error(`b4m-host: ${err.message}`);
      return HOST_EXIT_CODES.daemonAlreadyRunning;
    }
    logger.error('HOST: daemon failed to start', err);
    createStderrLogger(verbose).error(
      `b4m-host: the daemon failed to start: ${err instanceof Error ? err.message : String(err)}`
    );
    return HOST_EXIT_CODES.failure;
  }

  const running = daemon;
  return new Promise(resolve => {
    stop = () => {
      running.close().then(
        () => resolve(HOST_EXIT_CODES.ok),
        error => {
          logger.error('HOST: daemon shutdown failed', error);
          resolve(HOST_EXIT_CODES.failure);
        }
      );
    };
    if (received) stop();
  });
}
