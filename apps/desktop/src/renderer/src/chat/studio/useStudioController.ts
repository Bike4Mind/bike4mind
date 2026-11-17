import { useEffect, useRef, useState } from 'react';
import type { StudioLiveState } from '@shared/studioIpc';
import type { StudioController } from './controller';

export function useStudioController(
  sessionId: string | null,
  enabled: boolean,
  accountKey = ''
): StudioController | undefined {
  const [state, setState] = useState<StudioLiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const api = window.b4m.studio;
    const generation = ++epoch.current;
    setState(null);
    setError(null);
    if (!enabled || !sessionId || !api) return;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api.get(sessionId);
        if (epoch.current === generation) {
          setState(next);
          setError(null);
        }
      } catch (cause) {
        if (epoch.current === generation) setError(cause instanceof Error ? cause.message : 'Studio is unavailable.');
      } finally {
        pending = false;
      }
    };
    void refresh();
    const unsubscribe = api.onChanged(() => void refresh());
    const unsubscribeAuth = window.b4m.auth.onStateChanged(next => {
      if (`${next.environment.url}:${next.user?.id ?? ''}:${next.status}` === accountKey) return;
      epoch.current++;
      setState(null);
      setError('Account changed. Reopen Studio.');
    });
    const timer = setInterval(() => {
      if (epoch.current === generation) void refresh();
    }, 5000);
    return () => {
      epoch.current++;
      clearInterval(timer);
      unsubscribe();
      unsubscribeAuth();
    };
  }, [sessionId, enabled, accountKey]);
  if (!enabled || !sessionId || !window.b4m.studio) return undefined;
  const current = state?.sessionId === sessionId ? state : null;
  const requestEpoch = epoch.current;
  const check = () => {
    if (requestEpoch !== epoch.current) throw new Error('Studio session changed.');
  };
  return {
    sessionId,
    workspaceId: current?.workspace.workspaceId ?? '',
    revision: current?.revision ?? '',
    familyLabel: 'Session family',
    sessions: current?.sessions ?? [],
    capabilities: Object.fromEntries(
      ['image', 'video', 'music', 'speech', 'sound-effect'].map(kind => [
        kind,
        current?.available ? { status: 'available' } : { status: 'unavailable', reason: 'Sign in to create media.' },
      ])
    ),
    state: error
      ? { status: 'error', error }
      : current
        ? { status: 'ready', assets: current.workspace.assets, jobs: current.workspace.jobs }
        : { status: 'loading' },
    prepareCreation: async draft => {
      check();
      const review = await window.b4m.studio.prepare(draft);
      check();
      return review;
    },
    create: async request => {
      check();
      await window.b4m.studio.create(request);
      check();
    },
    pickFiles: async () => {
      check();
      const files = await window.b4m.studio.pickFiles(sessionId);
      check();
      return files;
    },
    previewAsset: async asset => {
      check();
      await window.b4m.studio.assetAction({ sessionId, assetId: asset.id, action: 'preview' });
    },
    renameAsset: async (asset, title) => {
      check();
      await window.b4m.studio.assetAction({ sessionId, assetId: asset.id, action: 'rename', title });
    },
    deleteAsset: async asset => {
      check();
      await window.b4m.studio.assetAction({ sessionId, assetId: asset.id, action: 'delete' });
    },
    exportAsset: async asset => {
      check();
      await window.b4m.studio.assetAction({ sessionId, assetId: asset.id, action: 'export' });
    },
    assetActionReasons: { reuse: 'Export the asset, then attach it to a message.' },
  };
}
