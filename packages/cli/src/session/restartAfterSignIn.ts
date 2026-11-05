import { extractErrorMessage } from '@bike4mind/utils';
import { logger } from '../utils/Logger';

export const SIGNED_IN_RESTART_MESSAGE = 'Signed in; starting a new session on Bike4Mind models.';

/** How long a sign-in waits for the running session's MCP servers to close before starting the new session (ms). */
export const MCP_STOP_TIMEOUT_MS = 5_000;

/**
 * A sign-in rebuilds the session from scratch, MCP servers included, so the running session's servers are stopped
 * first; otherwise each would run twice.
 */
export async function restartAfterSignIn({
  mcpManager,
  restart,
  print,
}: {
  mcpManager: { disconnect(): Promise<void> } | null;
  restart: () => Promise<void>;
  print: (line: string) => void;
}): Promise<void> {
  if (mcpManager) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        logger.debug(`MCP servers did not close within ${MCP_STOP_TIMEOUT_MS}ms; starting the new session anyway`);
        resolve();
      }, MCP_STOP_TIMEOUT_MS);
    });
    const stopped = mcpManager
      .disconnect()
      .catch((error: unknown) =>
        logger.debug(`MCP disconnect before sign-in restart failed: ${extractErrorMessage(error)}`)
      );
    await Promise.race([stopped, timedOut]);
    clearTimeout(timer);
  }
  print(SIGNED_IN_RESTART_MESSAGE);
  await restart();
}
