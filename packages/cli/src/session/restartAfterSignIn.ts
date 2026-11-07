import type { ReleasedSession } from './releaseSession.js';

export const SIGNED_IN_RESTART_MESSAGE = 'Signed in; starting a new session on Bike4Mind models.';

/** How long a sign-in waits for the running session to let go of its MCP servers and the rest (ms). */
export const SESSION_RELEASE_TIMEOUT_MS = 5_000;

/**
 * A sign-in rebuilds the session from scratch, so the running one is released first; otherwise its MCP servers,
 * feature modules and background agents would run alongside the new session's. Its background shells are
 * stopped too, so their output never reaches the signed-in session.
 */
export async function restartAfterSignIn({
  release,
  restart,
  print,
}: {
  release: () => Promise<ReleasedSession>;
  restart: () => Promise<void>;
  print: (line: string) => void;
}): Promise<void> {
  const released = await release().catch(() => null);
  const shells = released?.shellsStopped ?? 0;
  print(
    shells > 0
      ? `${SIGNED_IN_RESTART_MESSAGE} The local session's background shells (${shells}) were stopped.`
      : SIGNED_IN_RESTART_MESSAGE
  );
  await restart();
}
