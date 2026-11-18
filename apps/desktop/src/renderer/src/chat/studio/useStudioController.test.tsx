// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { StudioLiveState } from '@shared/studioIpc';
import type { StudioController } from './controller';
import { useStudioController } from './useStudioController';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('does not let an older refresh replace a newly loaded history page', async () => {
  const state: StudioLiveState = {
    sessionId: 'first',
    revision: 'revision',
    available: true,
    sessions: [],
    workspace: { workspaceId: 'family', rootSessionId: 'first', assets: [], jobs: [], nextAssetCursor: 'cursor' },
  };
  let refresh!: () => void;
  let resolveRefresh!: (value: StudioLiveState) => void;
  const get = vi
    .fn()
    .mockResolvedValueOnce(structuredClone(state))
    .mockImplementation(
      () =>
        new Promise<StudioLiveState>(resolve => {
          resolveRefresh = resolve;
        })
    );
  const original = window.b4m;
  Object.defineProperty(window, 'b4m', {
    configurable: true,
    value: {
      studio: {
        get,
        onChanged: (listener: () => void) => {
          refresh = listener;
          return () => {};
        },
        page: async () => ({
          collection: 'assets',
          items: [
            {
              id: 'extra',
              kind: 'image',
              title: 'Extra',
              originatingSessionId: 'first',
              createdAt: '',
              updatedAt: '',
              url: '',
            },
          ],
        }),
      },
      auth: { onStateChanged: () => () => {} },
    },
  });
  const root = createRoot(document.createElement('div'));
  let controller: StudioController | undefined;
  function Probe() {
    controller = useStudioController('first', true);
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => refresh());
    await act(async () => controller!.loadMore!('assets'));
    await act(async () => resolveRefresh(structuredClone(state)));
    expect(controller!.state).toEqual(expect.objectContaining({ assets: [expect.objectContaining({ id: 'extra' })] }));
  } finally {
    act(() => root.unmount());
    Object.defineProperty(window, 'b4m', { configurable: true, value: original });
  }
});

it('discards delayed workspace state and callbacks after a session switch', async () => {
  let resolveFirst!: (state: StudioLiveState) => void;
  const get = vi.fn((id: string) =>
    id === 'first'
      ? new Promise<StudioLiveState>(resolve => {
          resolveFirst = resolve;
        })
      : Promise.resolve({
          sessionId: id,
          revision: 'revision',
          workspace: { workspaceId: id, rootSessionId: id, assets: [], jobs: [] },
          sessions: [],
          available: true,
        })
  );
  const original = window.b4m;
  Object.defineProperty(window, 'b4m', {
    configurable: true,
    value: { studio: { get, onChanged: () => () => {} }, auth: { onStateChanged: () => () => {} } },
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  let controller: StudioController | undefined;
  function Probe({ id }: { id: string }) {
    controller = useStudioController(id, true);
    return null;
  }
  try {
    await act(async () => root.render(<Probe id="first" />));
    const stale = controller!;
    await act(async () => root.render(<Probe id="second" />));
    await act(async () =>
      resolveFirst({
        sessionId: 'first',
        revision: 'old',
        workspace: { workspaceId: 'first', rootSessionId: 'first', assets: [], jobs: [] },
        sessions: [],
        available: true,
      })
    );
    expect(controller!.sessionId).toBe('second');
    expect(controller!.workspaceId).toBe('second');
    await expect(stale.pickFiles!()).rejects.toThrow('Studio session changed');
  } finally {
    act(() => root.unmount());
    Object.defineProperty(window, 'b4m', { configurable: true, value: original });
  }
});
