import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledModelsResult, ModelPull, ModelRuntimeStatus } from '@shared/models';

export interface ModelHubState {
  status: ModelRuntimeStatus | null;
  installed: InstalledModelsResult | null;
  pulls: ModelPull[];
  refresh: () => Promise<void>;
}

export const DOWN_RECHECK_MS = 5_000;

/** Runtime health, installed models and pulls; pulls live in main, so they survive leaving the screen. */
export function useModelHub(): ModelHubState {
  const [status, setStatus] = useState<ModelRuntimeStatus | null>(null);
  const [installed, setInstalled] = useState<InstalledModelsResult | null>(null);
  const [pulls, setPulls] = useState<ModelPull[]>([]);

  const refresh = useCallback(async () => {
    const nextStatus = await window.b4m.models.getStatus();
    setStatus(nextStatus);
    setInstalled(
      nextStatus.reachable
        ? await window.b4m.models.listInstalled()
        : { ok: false, error: { kind: 'runtime-unavailable', message: 'Ollama is not running.' } }
    );
  }, []);

  const failedKeys = useRef(new Set<string>());
  const takePulls = useCallback(
    (next: ModelPull[]) => {
      setPulls(next);
      const failed = new Set(next.filter(pull => pull.phase === 'failed').map(pull => pull.key));
      const fresh = [...failed].some(key => !failedKeys.current.has(key));
      failedKeys.current = failed;
      // A failure is often Ollama stopping, so re-check it and let the status bar and Download buttons follow.
      if (fresh) void refresh();
    },
    [refresh]
  );

  useEffect(() => {
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
