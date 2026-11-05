import { logger } from '../utils/Logger';

/** What a running interactive session holds that must be let go of on exit or before a sign-in restart. */
export interface SessionResources {
  killShellSessions: () => void;
  killBangCommands: () => void;
  commandHistory: { whenIdle(): Promise<void> };
  saveSession: (() => Promise<void>) | null;
  mcpManager: { disconnect(): Promise<void> } | null;
  featureRegistry: { disposeAll(): void } | null;
  wsManager: { disconnect(): void } | null;
  clearWebSocketToolExecutor: () => void;
  stopBridgePresence: () => Promise<void>;
  agent: { removeAllListeners(): void } | null;
  backgroundManager: {
    listJobs(): { id: string; status: string }[];
    cancelJob(id: string): boolean;
  } | null;
  imageStore: { close(): void } | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Stops everything the session started, waiting at most `timeoutMs` for the asynchronous parts (session save,
 * MCP servers, bridge presence). Each step is best-effort, so one failure never skips the rest.
 */
export async function releaseSession(resources: SessionResources, timeoutMs: number): Promise<void> {
  const step = (name: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      logger.debug(`[CLEANUP] ${name} error: ${errorText(error)}`);
    }
  };
  const pending = (name: string, work: () => Promise<void>) =>
    Promise.resolve()
      .then(work)
      .catch(error => logger.debug(`[CLEANUP] ${name} error: ${errorText(error)}`));

  step('Shell session reap', resources.killShellSessions);
  step('Bang command reap', resources.killBangCommands);
  const tasks: Promise<void>[] = [pending('Command history', () => resources.commandHistory.whenIdle())];
  const { saveSession, mcpManager, featureRegistry, wsManager, agent, backgroundManager, imageStore } = resources;
  if (saveSession) tasks.push(pending('Session save', saveSession));
  if (mcpManager) tasks.push(pending('MCP disconnect', () => mcpManager.disconnect()));
  if (featureRegistry) step('Feature dispose', () => featureRegistry.disposeAll());
  if (wsManager) {
    step('WebSocket disconnect', () => wsManager.disconnect());
    step('WebSocket tool executor', resources.clearWebSocketToolExecutor);
  }
  tasks.push(pending('Bridge presence stop', resources.stopBridgePresence));
  if (agent) step('Agent listeners', () => agent.removeAllListeners());
  if (backgroundManager) {
    for (const job of backgroundManager.listJobs()) {
      if (job.status === 'running' || job.status === 'queued') {
        step('Background agent cancel', () => backgroundManager.cancelJob(job.id));
      }
    }
  }
  if (imageStore) step('Image store close', () => imageStore.close());

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(tasks),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
