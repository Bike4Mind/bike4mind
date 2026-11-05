export const SIGNED_IN_RESTART_MESSAGE = 'Signed in; starting a new session on Bike4Mind models.';

/** How long a sign-in waits for the running session to let go of its MCP servers and the rest (ms). */
export const SESSION_RELEASE_TIMEOUT_MS = 5_000;

/**
 * A sign-in rebuilds the session from scratch, so the running one is released first; otherwise its MCP servers,
 * feature modules and background agents would run alongside the new session's.
 */
export async function restartAfterSignIn({
  release,
  restart,
  print,
}: {
  release: () => Promise<void>;
  restart: () => Promise<void>;
  print: (line: string) => void;
}): Promise<void> {
  await release().catch(() => undefined);
  print(SIGNED_IN_RESTART_MESSAGE);
  await restart();
}
