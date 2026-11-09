// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_STATE, type ModelBuildOutcome, type ModelViewState } from '@shared/model3d';
import { useModelEngine, type ModelEngine } from './useModelEngine';

// The drawing and GLB encoding are three.js work covered elsewhere; this file is about build order.
vi.mock('./modelScene', () => ({
  buildModelObject: () => new THREE.Group(),
  exportGlb: async () => new Uint8Array([1]),
  loadAsset: vi.fn(),
  openPose: () => ({}),
  partsToStl: () => new Uint8Array([2]),
  renderContactSheet: vi.fn(async () => new Uint8Array([9])),
  summarizeObject: vi.fn(),
  summarizeParts: () => ({ parts: ['body'], size: [1, 1, 1], units: 'mm', triangles: 0, params: {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATE: ModelViewState = {
  path: '/project/chest.model.js',
  kind: 'model',
  generation: 1,
  source: 'export default () => null',
  missing: false,
};

const BUILT: ModelBuildOutcome = {
  ok: true,
  parts: [{ name: 'body', color: '#ffffff', positions: new Float32Array(), indices: new Uint32Array() }],
  params: {},
  units: 'mm',
};

type BuildRequest = { type: 'build'; id: number; print: boolean };

let host: HTMLDivElement;
let emitUpdate: (update: { sessionId: string; state: ModelViewState }) => void = () => {};
const emitState = (state: ModelViewState, sessionId = 'chat-a') => emitUpdate({ sessionId, state });
let activeSession: string | null = 'chat-a';
let captureListeners: ((request: { sessionId: string; id: string; views: string[]; pose: string }) => void)[] = [];
let root: Root;
let engine: ModelEngine;
let model: {
  writeGlb: ReturnType<typeof vi.fn>;
  reportBuild: ReturnType<typeof vi.fn>;
  saveExport: ReturnType<typeof vi.fn>;
};

function Harness() {
  engine = useModelEngine(false, activeSession);
  return null;
}

const flush = () => act(async () => {});

/** Mounts the hook with STATE open, answers the engine's ready ping, and returns the frame's requests. */
async function mountWithEngine(): Promise<{ frame: HTMLIFrameElement; requests: BuildRequest[] }> {
  act(() => root.render(<Harness />));
  await flush();
  const frame = document.querySelector<HTMLIFrameElement>('[data-testid="model-engine-frame"]');
  if (!frame?.contentWindow) throw new Error('the engine frame was not mounted');
  const requests: BuildRequest[] = [];
  vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation((data: unknown) => {
    requests.push(data as BuildRequest);
  });
  reply(frame, { type: 'engine-ready' });
  await flush();
  return { frame, requests };
}

function reply(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
}

beforeEach(() => {
  activeSession = 'chat-a';
  captureListeners = [];
  model = {
    writeGlb: vi.fn(async () => '/project/chest.glb'),
    reportBuild: vi.fn(async () => {}),
    saveExport: vi.fn(async () => '/project/chest.stl'),
  };
  (window as unknown as { b4m: unknown }).b4m = {
    model: {
      ...model,
      onState: (listener: typeof emitUpdate) => {
        emitUpdate = listener;
        return () => {};
      },
      getState: vi.fn(async (sessionId: string) => (sessionId === 'chat-a' ? STATE : EMPTY_MODEL_STATE)),
      onCaptureRequest: (listener: (typeof captureListeners)[number]) => {
        captureListeners.push(listener);
        return () => {
          captureListeners = captureListeners.filter(entry => entry !== listener);
        };
      },
      captureResult: vi.fn(),
      setParam: vi.fn(),
      openDialog: vi.fn(),
      readAsset: vi.fn(),
    },
  };
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    callback(0);
    return 1;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useModelEngine', () => {
  it('lets a file build finish, write its GLB and report before a slider preview runs', async () => {
    const { frame, requests } = await mountWithEngine();
    expect(requests).toEqual([expect.objectContaining({ type: 'build', id: 1, print: false })]);

    act(() => engine.previewParam('width', 80));
    await flush();
    expect(requests).toHaveLength(1);

    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    expect(model.writeGlb).toHaveBeenCalledWith('chat-a', expect.objectContaining({ generation: 1 }));
    expect(model.reportBuild).toHaveBeenCalledWith('chat-a', expect.objectContaining({ generation: 1, ok: true }));
    expect(requests.at(-1)).toEqual(expect.objectContaining({ type: 'build', id: 2, print: false }));
  });

  it('queues an STL export behind a file build instead of cancelling it', async () => {
    const { frame, requests } = await mountWithEngine();
    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();

    act(() => emitState({ ...STATE, generation: 2, source: 'export default () => [] ' }));
    await flush();
    expect(requests.at(-1)).toEqual(expect.objectContaining({ id: 2, print: false }));

    let exported: Promise<string | null> = Promise.resolve(null);
    act(() => {
      exported = engine.exportFile('stl');
    });
    await flush();
    expect(requests).toHaveLength(2);

    reply(frame, { type: 'built', id: 2, outcome: BUILT });
    await flush();
    expect(model.reportBuild).toHaveBeenCalledWith('chat-a', expect.objectContaining({ generation: 2, ok: true }));
    expect(requests.at(-1)).toEqual(expect.objectContaining({ id: 3, print: true }));

    reply(frame, { type: 'built', id: 3, outcome: BUILT });
    await act(async () => {
      expect(await exported).toBe('/project/chest.stl');
    });
    expect(model.saveExport).toHaveBeenCalledWith('chat-a', expect.objectContaining({ format: 'stl' }));
  });

  it('reports why the GLB was not written', async () => {
    model.writeGlb.mockRejectedValueOnce(new Error('EROFS: read-only file system'));
    const { frame } = await mountWithEngine();
    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    expect(model.reportBuild).toHaveBeenCalledWith(
      'chat-a',
      expect.objectContaining({ ok: true, glbError: 'EROFS: read-only file system' })
    );
  });

  it("starts a new conversation with no model while another conversation's stays open", async () => {
    activeSession = 'chat-b';
    act(() => root.render(<Harness />));
    await flush();
    expect(engine.state.path).toBeNull();

    act(() => emitState({ ...STATE, generation: 2 }, 'chat-a'));
    await flush();
    expect(engine.state.path).toBeNull();
    expect(engine.status).toBe('idle');
    expect(document.querySelector('[data-testid="model-engine-frame"]')).toBeNull();
  });

  it("brings a conversation's model back when switching to it, and drops it on leaving", async () => {
    const { frame } = await mountWithEngine();
    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    expect(engine.state.path).toBe(STATE.path);

    activeSession = 'chat-b';
    act(() => root.render(<Harness />));
    // No frame of the previous chat's model: it is gone on the same render.
    expect(engine.state.path).toBeNull();
    expect(engine.object).toBeNull();
    await flush();

    activeSession = 'chat-a';
    act(() => root.render(<Harness />));
    await flush();
    expect(engine.state.path).toBe(STATE.path);
    expect(window.b4m.model.getState).toHaveBeenLastCalledWith('chat-a');
  });

  it('captures the active conversation from a separate build before its pane object is ready', async () => {
    const { frame, requests } = await mountWithEngine();
    expect(engine.object).toBeNull();
    vi.mocked(window.b4m.model.getState).mockClear();

    act(() => {
      for (const listener of captureListeners)
        listener({ sessionId: 'chat-a', id: 'shot', views: ['front'], pose: 'rest' });
    });
    await flush();
    expect(window.b4m.model.getState).toHaveBeenCalledExactlyOnceWith('chat-a');
    const captureFrame = [...document.querySelectorAll<HTMLIFrameElement>('[data-testid="model-engine-frame"]')].find(
      candidate => candidate !== frame
    );
    if (!captureFrame?.contentWindow) throw new Error('the capture frame was not mounted');
    const captureRequests: BuildRequest[] = [];
    vi.spyOn(captureFrame.contentWindow, 'postMessage').mockImplementation((data: unknown) => {
      captureRequests.push(data as BuildRequest);
    });
    reply(captureFrame, { type: 'engine-ready' });
    await flush();
    expect(captureRequests).toEqual([expect.objectContaining({ type: 'build', id: 1 })]);
    reply(captureFrame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    expect(window.b4m.model.captureResult).toHaveBeenCalledExactlyOnceWith({
      id: 'shot',
      bytes: new Uint8Array([9]),
    });
    expect(engine.object).toBeNull();
    expect(requests).toHaveLength(1);

    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    expect(engine.object).not.toBeNull();
    expect(model.reportBuild).toHaveBeenCalledWith('chat-a', expect.objectContaining({ ok: true }));
  });

  it("leaves another conversation's screenshot request to the background builder", async () => {
    const { frame } = await mountWithEngine();
    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    for (const listener of captureListeners)
      listener({ sessionId: 'chat-b', id: 'shot', views: ['front'], pose: 'rest' });
    await flush();
    expect(window.b4m.model.captureResult).not.toHaveBeenCalled();
  });
});
