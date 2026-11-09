// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_MODEL_STATE,
  type ModelBuildOutcome,
  type ModelCaptureRequestEvent,
  type ModelStateUpdate,
  type ModelViewState,
} from '@shared/model3d';
import { useModelBackgroundBuilds } from './useModelBackgroundBuilds';

vi.mock('./modelScene', () => ({
  buildModelObject: () => new THREE.Group(),
  exportGlb: async () => new Uint8Array([1]),
  loadAsset: vi.fn(),
  openPose: () => ({}),
  renderContactSheet: vi.fn(async () => new Uint8Array([9])),
  summarizeObject: vi.fn(),
  summarizeParts: () => ({ parts: ['body'], size: [1, 1, 1], units: 'mm', triangles: 0, params: {} }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATE: ModelViewState = {
  path: '/project/chest.model.js',
  kind: 'model',
  generation: 3,
  source: 'export default () => null',
  missing: false,
};

const BUILT: ModelBuildOutcome = {
  ok: true,
  parts: [{ name: 'body', color: '#ffffff', positions: new Float32Array(), indices: new Uint32Array() }],
  params: {},
  units: 'mm',
};

let host: HTMLDivElement;
let root: Root;
let active: string | null;
let emitState: (update: ModelStateUpdate) => void = () => {};
let emitCapture: (request: ModelCaptureRequestEvent) => void = () => {};
let states: Record<string, ModelViewState>;
let model: {
  writeGlb: ReturnType<typeof vi.fn>;
  reportBuild: ReturnType<typeof vi.fn>;
  captureResult: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
};

function Harness() {
  useModelBackgroundBuilds(active, false);
  return null;
}

const flush = () => act(async () => {});

/** Answers every build the engine frame is asked for with BUILT, once it says it is ready. */
async function answerBuilds(): Promise<{ type: string; id: number }[]> {
  const frame = document.querySelector<HTMLIFrameElement>('[data-testid="model-engine-frame"]');
  if (!frame?.contentWindow) throw new Error('the engine frame was not mounted');
  const requests: { type: string; id: number }[] = [];
  vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation((data: unknown) => {
    const request = data as { type: string; id: number };
    requests.push(request);
    queueMicrotask(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'built', id: request.id, outcome: BUILT },
          source: frame.contentWindow,
        })
      )
    );
  });
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'engine-ready' }, source: frame.contentWindow }));
  await flush();
  await flush();
  return requests;
}

beforeEach(() => {
  active = 'chat-a';
  states = { 'chat-b': STATE };
  model = {
    writeGlb: vi.fn(async () => '/project/chest.glb'),
    reportBuild: vi.fn(async () => {}),
    captureResult: vi.fn(),
    getState: vi.fn(async (sessionId: string) => states[sessionId] ?? EMPTY_MODEL_STATE),
  };
  (window as unknown as { b4m: unknown }).b4m = {
    model: {
      ...model,
      readAsset: vi.fn(),
      onState: (listener: typeof emitState) => {
        emitState = listener;
        return () => {};
      },
      onCaptureRequest: (listener: typeof emitCapture) => {
        emitCapture = listener;
        return () => {};
      },
    },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useModelBackgroundBuilds', () => {
  it("builds a background conversation's new generation, writes its GLB and reports it for that conversation", async () => {
    act(() => emitState({ sessionId: 'chat-b', state: STATE }));
    await flush();
    await answerBuilds();
    expect(model.writeGlb).toHaveBeenCalledWith('chat-b', expect.objectContaining({ generation: 3 }));
    expect(model.reportBuild).toHaveBeenCalledWith('chat-b', expect.objectContaining({ generation: 3, ok: true }));
  });

  it('leaves the conversation on screen to the pane', async () => {
    act(() => emitState({ sessionId: 'chat-a', state: STATE }));
    await flush();
    expect(document.querySelector('[data-testid="model-engine-frame"]')).toBeNull();
    expect(model.reportBuild).not.toHaveBeenCalled();
  });

  it("renders a background conversation's screenshot from a fresh build of its own model", async () => {
    act(() => emitCapture({ sessionId: 'chat-b', id: 'shot', views: ['front'], pose: 'rest' }));
    await flush();
    await answerBuilds();
    expect(model.getState).toHaveBeenCalledWith('chat-b');
    expect(model.captureResult).toHaveBeenCalledWith({ id: 'shot', bytes: new Uint8Array([9]) });
  });

  it('builds the conversation the user just left, so a tool waiting on it is answered', async () => {
    active = 'chat-b';
    act(() => root.render(<Harness />));
    active = 'chat-c';
    act(() => root.render(<Harness />));
    await flush();
    await answerBuilds();
    expect(model.reportBuild).toHaveBeenCalledWith('chat-b', expect.objectContaining({ generation: 3, ok: true }));
  });
});
