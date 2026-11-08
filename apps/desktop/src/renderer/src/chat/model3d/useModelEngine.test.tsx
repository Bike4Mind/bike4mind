// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelBuildOutcome, ModelViewState } from '@shared/model3d';
import { useModelEngine, type ModelEngine } from './useModelEngine';

// The drawing and GLB encoding are three.js work covered elsewhere; this file is about build order.
vi.mock('./modelScene', () => ({
  buildModelObject: () => new THREE.Group(),
  exportGlb: async () => new Uint8Array([1]),
  loadAsset: vi.fn(),
  openPose: () => ({}),
  partsToStl: () => new Uint8Array([2]),
  renderContactSheet: vi.fn(),
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
let emitState: (state: ModelViewState) => void = () => {};
let root: Root;
let engine: ModelEngine;
let model: {
  writeGlb: ReturnType<typeof vi.fn>;
  reportBuild: ReturnType<typeof vi.fn>;
  saveExport: ReturnType<typeof vi.fn>;
};

function Harness() {
  engine = useModelEngine(false);
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
  model = {
    writeGlb: vi.fn(async () => '/project/chest.glb'),
    reportBuild: vi.fn(async () => {}),
    saveExport: vi.fn(async () => '/project/chest.stl'),
  };
  (window as unknown as { b4m: unknown }).b4m = {
    model: {
      ...model,
      onState: (listener: (state: ModelViewState) => void) => {
        emitState = listener;
        return () => {};
      },
      getState: async () => STATE,
      onCaptureRequest: () => () => {},
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
    expect(model.writeGlb).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
    expect(model.reportBuild).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, ok: true }));
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
    expect(model.reportBuild).toHaveBeenCalledWith(expect.objectContaining({ generation: 2, ok: true }));
    expect(requests.at(-1)).toEqual(expect.objectContaining({ id: 3, print: true }));

    reply(frame, { type: 'built', id: 3, outcome: BUILT });
    await act(async () => {
      expect(await exported).toBe('/project/chest.stl');
    });
    expect(model.saveExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'stl' }));
  });

  it('reports why the GLB was not written', async () => {
    model.writeGlb.mockRejectedValueOnce(new Error('EROFS: read-only file system'));
    const { frame } = await mountWithEngine();
    reply(frame, { type: 'built', id: 1, outcome: BUILT });
    await flush();
    expect(model.reportBuild).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, glbError: 'EROFS: read-only file system' })
    );
  });
});
