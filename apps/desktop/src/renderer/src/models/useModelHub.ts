import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledModelsResult, ModelPull, ModelRuntimeStatus } from '@shared/models';
import type { ModelServerView } from '@shared/modelServers';

export interface ModelHubState {
  status: ModelRuntimeStatus | null;
  installed: InstalledModelsResult | null;
  pulls: ModelPull[];
  refresh: () => Promise<void>;
}

export const DOWN_RECHECK_MS = 5_000;

/**
 * Runtime health and installed models of one server, and every pull; pulls live in main, so they survive
 * leaving the screen or switching servers.
 */
export function useModelHub(serverId: string): ModelHubState {
  const [status, setStatus] = useState<ModelRuntimeStatus | null>(null);
  const [installed, setInstalled] = useState<InstalledModelsResult | null>(null);
  const [pulls, setPulls] = useState<ModelPull[]>([]);
  const current = useRef(serverId);
  current.current = serverId;

  const refresh = useCallback(async () => {
    const nextStatus = await window.b4m.models.getStatus(serverId);
    if (current.current !== serverId) return;
    setStatus(nextStatus);
    const nextInstalled: InstalledModelsResult = nextStatus.reachable
      ? await window.b4m.models.listInstalled(serverId)
      : {
          ok: false,
          error: { kind: 'runtime-unavailable', message: nextStatus.error ?? 'Ollama is not running.' },
        };
    if (current.current === serverId) setInstalled(nextInstalled);
  }, [serverId]);

  const failedKeys = useRef(new Set<string>());
  const takePulls = useCallback(
    (next: ModelPull[]) => {
      setPulls(next);
      const failed = new Set(
        next.filter(pull => pull.phase === 'failed' || pull.phase === 'paused').map(pull => pull.key)
      );
      const fresh = [...failed].some(key => !failedKeys.current.has(key));
      failedKeys.current = failed;
      // A failure is often the runtime stopping, so re-check it and let the status bar and Download buttons follow.
      if (fresh) void refresh();
    },
    [refresh]
  );

  useEffect(() => {
    setStatus(null);
    setInstalled(null);
    void refresh();
    void window.b4m.models.listPulls().then(takePulls);
    const offPulls = window.b4m.models.onPullsChanged(takePulls);
    const offInstalled = window.b4m.models.onInstalledChanged(() => void refresh());
    return () => {
      offPulls();
      offInstalled();
    };
  }, [refresh, takePulls]);

  // A check that missed a busy daemon reads as down, and nothing else would check again until a click.
  useEffect(() => {
    if (!status || status.reachable) return;
    const timer = setTimeout(() => void refresh(), DOWN_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  return { status, installed, pulls, refresh };
}

/** The saved model servers, "This computer" first, kept current as Settings changes them. */
export function useModelServers(): ModelServerView[] | null {
  const [servers, setServers] = useState<ModelServerView[] | null>(null);
  useEffect(() => {
    let live = true;
    void window.b4m.modelServers.list().then(next => live && setServers(next));
    const off = window.b4m.modelServers.onChanged(next => live && setServers(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  return servers;
}
