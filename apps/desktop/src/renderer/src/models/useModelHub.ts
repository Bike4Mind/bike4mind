import { useCallback, useEffect, useState } from 'react';
import type { InstalledModelsResult, ModelPull, ModelRuntimeStatus } from '@shared/models';

export interface ModelHubState {
  status: ModelRuntimeStatus | null;
  installed: InstalledModelsResult | null;
  pulls: ModelPull[];
  refresh: () => Promise<void>;
}

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

  useEffect(() => {
    void refresh();
    void window.b4m.models.listPulls().then(setPulls);
    const offPulls = window.b4m.models.onPullsChanged(setPulls);
    const offInstalled = window.b4m.models.onInstalledChanged(() => void refresh());
    return () => {
      offPulls();
      offInstalled();
    };
  }, [refresh]);

  return { status, installed, pulls, refresh };
}
