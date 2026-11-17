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
  const pages = useRef({ assets: 1, jobs: 1 });
  const readVersion = useRef(0);
  useEffect(() => {
    const api = window.b4m.studio;
    const generation = ++epoch.current;
    setState(null);
    setError(null);
    pages.current = { assets: 1, jobs: 1 };
    if (!enabled || !sessionId || !api) return;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const version = readVersion.current;
      try {
        const next = await api.get(sessionId);
        for (const collection of ['assets', 'jobs'] as const) {
          for (let page = 1; page < pages.current[collection]; page++) {
            const cursor = collection === 'assets' ? next.workspace.nextAssetCursor : next.workspace.nextJobCursor;
            if (!cursor || epoch.current !== generation) break;
            const result = await api.page({ sessionId, collection, cursor });
            if (result.collection === 'assets') {
              next.workspace.assets.push(...result.items);
              next.workspace.nextAssetCursor = result.nextCursor;
            } else {
              next.workspace.jobs.push(...result.items);
              next.workspace.nextJobCursor = result.nextCursor;
            }
          }
        }
        if (epoch.current === generation && version === readVersion.current) {
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
    catalog: current?.catalog,
    uploadReference: async () => {
      check();
      const reference = await window.b4m.studio.uploadReference(sessionId);
      check();
      return reference;
    },
    hasMoreAssets: !!current?.workspace.nextAssetCursor,
    jobAction: async (jobId, action) => {
      check();
      await window.b4m.studio.jobAction({ sessionId, jobId, action });
      check();
    },
    hasMoreJobs: !!current?.workspace.nextJobCursor,
    loadMore: async collection => {
      check();
      const cursor = collection === 'assets' ? current?.workspace.nextAssetCursor : current?.workspace.nextJobCursor;
      if (!cursor) return;
      readVersion.current++;
      const page = await window.b4m.studio.page({ sessionId, collection, cursor });
      check();
      readVersion.current++;
      pages.current[collection]++;
      setState(previous => {
        if (!previous || previous.sessionId !== sessionId) return previous;
        const workspace = { ...previous.workspace };
        if (page.collection === 'assets') {
          workspace.assets = [...new Map([...workspace.assets, ...page.items].map(item => [item.id, item])).values()];
          workspace.nextAssetCursor = page.nextCursor;
        } else {
          workspace.jobs = [...new Map([...workspace.jobs, ...page.items].map(item => [item.id, item])).values()];
          workspace.nextJobCursor = page.nextCursor;
        }
        return { ...previous, workspace };
      });
    },
    capabilities: Object.fromEntries(
      ['image', 'video', 'music', 'speech', 'sound-effect'].map(kind => [
        kind,
        current?.available
          ? current.unavailableKinds?.includes(kind)
            ? { status: 'unavailable', reason: 'No models are available on this server.' }
            : { status: 'available' }
          : { status: 'unavailable', reason: 'Sign in to create media.' },
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
  };
}
