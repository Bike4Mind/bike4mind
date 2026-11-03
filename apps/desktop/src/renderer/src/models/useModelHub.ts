import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstalledModelsResult, ModelPull, ModelRuntimeStatus } from '@shared/models';
import type { ModelServerView } from '@shared/modelServers';
import { installedCache, type LastInstalled } from './installedCache';

export interface ModelHubState {
  status: ModelRuntimeStatus | null;
  installed: InstalledModelsResult | null;
  pulls: ModelPull[];
  /** This server's last successful listing in this run, shown while `installed` is pending or failed. */
  lastInstalled: LastInstalled | null;
  refresh: () => Promise<void>;
}

export const DOWN_RECHECK_MS = 5_000;

/**
 * Runtime health and installed models of one server, and every pull; pulls live in main, so they survive
 * leaving the screen or switching servers.
 */
export function useModelHub(serverId: string, identity: string | null = null): ModelHubState {
  const [status, setStatus] = useState<ModelRuntimeStatus | null>(null);
  const [installed, setInstalledState] = useState<InstalledModelsResult | null>(null);
  const shownServer = useRef({ serverId, identity });
  shownServer.current = { serverId, identity };
  const setInstalled = useCallback(
    (next: InstalledModelsResult | null) => {
      const shown = shownServer.current;
      if (next?.ok && shown.serverId === serverId && shown.identity !== null)
        installedCache.set(serverId, shown.identity, next.models, Date.now());
      setInstalledState(next);
    },
    [serverId]
  );
  const [pulls, setPulls] = useState<ModelPull[]>([]);
  // Only the latest request of each kind may set state; an older one resolving later is dropped.
  const statusSeq = useRef(0);
  const installedSeq = useRef(0);
  const shownStatus = useRef<ModelRuntimeStatus | null>(null);
  const showStatus = useCallback((next: ModelRuntimeStatus | null) => {
    shownStatus.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++statusSeq.current;
    const mineInstalled = ++installedSeq.current;
    const nextStatus = await window.b4m.models.getStatus(serverId);
    if (mine !== statusSeq.current) return;
    showStatus(nextStatus);
    const nextInstalled: InstalledModelsResult = nextStatus.reachable
      ? await window.b4m.models.listInstalled(serverId)
      : {
          ok: false,
          error: { kind: 'runtime-unavailable', message: nextStatus.error ?? 'Ollama is not running.' },
        };
    if (mineInstalled === installedSeq.current) setInstalled(nextInstalled);
  }, [serverId, showStatus, setInstalled]);

  const reloadInstalled = useCallback(async () => {
    const mine = ++installedSeq.current;
    const next = await window.b4m.models.listInstalled(serverId);
    if (mine === installedSeq.current) setInstalled(next);
  }, [serverId, setInstalled]);

  const failedKeys = useRef(new Set<string>());
  const takePulls = useCallback(
    (next: ModelPull[]) => {
      setPulls(next);
      const failed = new Set(
        next.filter(pull => pull.phase === 'failed' || pull.phase === 'paused').map(pull => pull.key)
      );
      const fresh = next.some(
        pull => failed.has(pull.key) && pull.serverId === serverId && !failedKeys.current.has(pull.key)
      );
      failedKeys.current = failed;
      // A failure is often the runtime stopping, so re-check it and let the status bar and Download buttons follow.
      if (fresh) void refresh();
    },
    [refresh, serverId]
  );

  useEffect(() => {
    showStatus(null);
    setInstalled(null);
    void refresh();
    void window.b4m.models.listPulls().then(takePulls);
    const offPulls = window.b4m.models.onPullsChanged(takePulls);
    const offInstalled = window.b4m.models.onInstalledChanged(changed => {
      if (changed !== serverId) return;
      // A pull or removal just finished there, so the server answered; a status shown as down is stale.
      const shown = shownStatus.current;
      if (shown?.serverId === serverId && shown.reachable) void reloadInstalled();
      else void refresh();
    });
    return () => {
      offPulls();
      offInstalled();
    };
  }, [serverId, refresh, reloadInstalled, takePulls, showStatus, setInstalled]);

  // A check that missed a busy daemon reads as down, and nothing else would check again until a click.
  useEffect(() => {
    if (!status || status.reachable) return;
    const timer = setTimeout(() => void refresh(), DOWN_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  return { status, installed, pulls, lastInstalled: installedCache.get(serverId, identity), refresh };
}

/** The saved model servers, "This computer" first, kept current as Settings changes them. */
export function useModelServers(): ModelServerView[] | null {
  const [servers, setServers] = useState<ModelServerView[] | null>(null);
  useEffect(() => {
    let live = true;
    const take = (next: ModelServerView[]) => {
      if (!live) return;
      installedCache.retain(next);
      setServers(next);
    };
    void window.b4m.modelServers.list().then(take);
    const off = window.b4m.modelServers.onChanged(take);
    return () => {
      live = false;
      off();
    };
  }, []);
  return servers;
}
