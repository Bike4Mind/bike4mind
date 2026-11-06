// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_STATE } from '@shared/model3d';
import type { ModelEngine } from './model3d/useModelEngine';
import type { ModelViewportHandle } from './model3d/ModelViewport';
import { MODEL_EXAMPLE_PROMPTS, ModelPane } from './ModelPane';

const handle = vi.hoisted(() => ({
  recordTurntable: vi.fn<ModelViewportHandle['recordTurntable']>(async () => new Uint8Array([1, 2, 3])),
  setView: vi.fn(),
  orbit: vi.fn(),
  zoom: vi.fn(),
}));

// jsdom has no WebGL; the viewport is covered by the live app, not here.
vi.mock('./model3d/ModelViewport', () => ({
  ModelViewport: ({
    dimmed,
    lighting,
    pose,
    picked,
    onPick,
    clip,
    exploded,
    handleRef,
  }: {
    dimmed: boolean;
    lighting: string;
    pose: Record<string, number>;
    picked: string | null;
    onPick: (name: string | null) => void;
    clip: string | null;
    exploded: boolean;
    handleRef?: { current: unknown };
  }) => {
    if (handleRef) handleRef.current = handle;
    return (
      <div
        data-testid="model-pane-viewport"
        data-dimmed={String(dimmed)}
        data-lighting={lighting}
        data-pose={JSON.stringify(pose)}
        data-picked={picked ?? ''}
        data-clip={clip ?? ''}
        data-exploded={String(exploded)}
      >
        <button data-testid="pick-lid" onClick={() => onPick('lid')} />
        <button data-testid="pick-none" onClick={() => onPick(null)} />
      </div>
    );
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function engine(overrides: Partial<ModelEngine> = {}): ModelEngine {
  return {
    state: EMPTY_MODEL_STATE,
    status: 'idle',
    error: null,
    object: null,
    summary: null,
    params: {},
    unsaved: [],
    joints: [],
    jointAngles: {},
    clips: [],
    setJointAngles: vi.fn(),
    previewParam: vi.fn(),
    commitParam: vi.fn(async () => {}),
    exportFile: vi.fn(async () => '/project/chest.glb'),
    openFile: vi.fn(async () => {}),
    ...overrides,
  };
}

const BUILT: Partial<ModelEngine> = {
  state: { path: '/project/chest.model.js', kind: 'model', generation: 2, source: 'x', missing: false },
  status: 'ok',
  object: new THREE.Group(),
  summary: { parts: ['body'], size: [60, 40, 30], units: 'mm', triangles: 120, params: { width: 60 } },
  params: { width: { value: 60, min: 20, max: 120, step: 1 } },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(
  model: ModelEngine,
  props: { onClose?: () => void; onExamplePrompt?: (text: string) => void; onPickPart?: (text: string) => void } = {}
) {
  act(() =>
    root.render(
      <CssVarsProvider>
        <ModelPane
          engine={model}
          dark={false}
          onClose={props.onClose ?? (() => {})}
          onExamplePrompt={props.onExamplePrompt ?? (() => {})}
          onPickPart={props.onPickPart ?? (() => {})}
        />
      </CssVarsProvider>
    )
  );
}

// Menus portal to the body, so look there rather than in the pane alone.
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('ModelPane', () => {
  it('offers example prompts that fill the composer when no model is open', () => {
    const onExamplePrompt = vi.fn();
    render(engine(), { onExamplePrompt });
    expect(byTestId('model-pane-empty')).not.toBeNull();
    expect(byTestId('model-pane-viewport')).toBeNull();
    act(() => byTestId('model-pane-example-0')?.click());
    expect(onExamplePrompt).toHaveBeenCalledWith(MODEL_EXAMPLE_PROMPTS[0]);
  });

  it('shows the file, its size and a slider per param once built', () => {
    render(engine(BUILT));
    expect(byTestId('model-pane-title')?.textContent).toBe('chest.model.js');
    expect(byTestId('model-pane-status')?.textContent).toBe('Ready');
    expect(byTestId('model-pane-size')?.textContent).toContain('60 x 40 x 30 mm');
    expect(byTestId('model-pane-param-width')).not.toBeNull();
    expect(byTestId('model-pane-export-btn')?.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the last good model dimmed under the error', () => {
    render(engine({ ...BUILT, status: 'error', error: { message: 'width is not defined', line: 7 } }));
    expect(byTestId('model-pane-error')?.textContent).toBe('Line 7: width is not defined');
    expect(byTestId('model-pane-viewport')?.dataset.dimmed).toBe('true');
    expect(byTestId('model-pane-export-btn')?.hasAttribute('disabled')).toBe(false);
  });

  it('says which params could not be written back', () => {
    render(engine({ ...BUILT, unsaved: ['width'] }));
    expect(byTestId('model-pane-unsaved')?.textContent).toContain('width');
  });

  it('exports and reports where the file went', async () => {
    const model = engine(BUILT);
    render(model);
    act(() => byTestId('model-pane-export-btn')?.click());
    await act(async () => byTestId('model-pane-export-glb-btn')?.click());
    expect(model.exportFile).toHaveBeenCalledWith('glb');
    expect(byTestId('model-pane-note')?.textContent).toBe('Saved chest.glb');
  });

  it('says why a picked file could not be opened', async () => {
    const model = engine({
      openFile: vi.fn(async () => {
        throw new Error("Error invoking remote method 'model:open-dialog': Error: Not a model file: /a/b.js.");
      }),
    });
    render(model);
    await act(async () => byTestId('model-pane-open-empty-btn')?.click());
    expect(byTestId('model-pane-note')?.textContent).toBe('Not a model file: /a/b.js.');
  });

  it('only offers STL for model files, since a loaded asset has no source parts', () => {
    render(engine({ ...BUILT, state: { ...BUILT.state!, path: '/project/chest.glb', kind: 'glb' }, params: {} }));
    act(() => byTestId('model-pane-export-btn')?.click());
    expect(byTestId('model-pane-export-stl-btn')?.getAttribute('aria-disabled')).toBe('true');
    expect(byTestId('model-pane-params')).toBeNull();
  });

  it('shows no joints section for a model without joints', () => {
    render(engine(BUILT));
    expect(byTestId('model-pane-joints')).toBeNull();
  });

  it('poses the viewer from a joint slider and stops playback when dragged', () => {
    const setJointAngles = vi.fn();
    const joints = [
      {
        name: 'lid',
        motion: 'turn' as const,
        axis: [1, 0, 0] as [number, number, number],
        range: [0, 110] as [number, number],
      },
    ];
    render(engine({ ...BUILT, joints, jointAngles: { lid: 40 }, setJointAngles }));
    expect(byTestId('model-pane-viewport')?.dataset.pose).toBe('{"lid":40}');
    expect(byTestId('model-pane-joints')?.textContent).toContain('40\u00b0');
    act(() => byTestId('model-pane-joints-play-btn')?.click());
    expect(byTestId('model-pane-joints-play-btn')?.textContent).toBe('Stop');
    const input = byTestId('model-pane-joint-lid')?.querySelector('input') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '75');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setJointAngles).toHaveBeenLastCalledWith({ lid: 75 });
    expect(byTestId('model-pane-joints-play-btn')?.textContent).toBe('Play');
  });

  it('highlights a clicked part and mentions it once in the draft', () => {
    const onPickPart = vi.fn();
    const twoParts = { ...BUILT, summary: { ...BUILT.summary!, parts: ['body', 'lid'] } };
    render(engine(twoParts), { onPickPart });
    expect(byTestId('model-pane-size')?.textContent).toContain('click a part to mention it');
    act(() => byTestId('pick-lid')?.click());
    expect(onPickPart).toHaveBeenCalledWith('the `lid` part ');
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('lid');
    expect(byTestId('model-pane-size')?.textContent).toContain('- lid');
    // Clicking it again clears the highlight without mentioning it twice; so does empty space.
    act(() => byTestId('pick-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('');
    act(() => byTestId('pick-lid')?.click());
    act(() => byTestId('pick-none')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('');
    expect(onPickPart).toHaveBeenCalledTimes(2);
  });

  it('plays one animation of an opened GLB at a time', () => {
    const glb = {
      ...BUILT,
      state: { path: '/project/chest.glb', kind: 'glb' as const, generation: 3, source: null, missing: false },
      clips: ['lid', 'drawer'],
    };
    render(engine(BUILT));
    expect(byTestId('model-pane-clips')).toBeNull();
    render(engine(glb));
    act(() => byTestId('model-pane-clip-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('lid');
    expect(byTestId('model-pane-clip-lid')?.textContent).toBe('Stop');
    act(() => byTestId('model-pane-clip-drawer')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('drawer');
    expect(byTestId('model-pane-clip-lid')?.textContent).toBe('Play');
    act(() => byTestId('model-pane-clip-drawer')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('');
  });

  it('switches the viewport to night lighting and back', () => {
    render(engine(BUILT));
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('studio');
    act(() => byTestId('model-pane-night-btn')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('night');
    expect(byTestId('model-pane-night-btn')?.getAttribute('aria-pressed')).toBe('true');
    act(() => byTestId('model-pane-night-btn')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('studio');
  });

  it('records a turntable of the joints, stops playback first, and saves it as WebM', async () => {
    const saveExport = vi.fn(async () => '/project/chest-turntable.webm');
    (window as unknown as { b4m: unknown }).b4m = { model: { saveExport } };
    const joints = [
      {
        name: 'lid',
        motion: 'turn' as const,
        axis: [1, 0, 0] as [number, number, number],
        range: [0, 100] as [number, number],
      },
    ];
    const glb = {
      ...BUILT,
      state: { path: '/project/chest.glb', kind: 'glb' as const, generation: 3, source: null, missing: false },
      clips: ['lid'],
      joints,
    };
    render(engine(glb));
    act(() => byTestId('model-pane-clip-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('lid');
    await act(async () => byTestId('model-pane-record-btn')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('');
    expect(handle.recordTurntable).toHaveBeenCalledWith(joints, expect.any(Function));
    expect(saveExport).toHaveBeenCalledWith({ format: 'webm', bytes: new Uint8Array([1, 2, 3]) });
    expect(byTestId('model-pane-note')?.textContent).toBe('Saved chest-turntable.webm');
  });

  it('shows recording progress on the view and the button while a turntable records', async () => {
    const saveExport = vi.fn(async () => null);
    (window as unknown as { b4m: unknown }).b4m = { model: { saveExport } };
    let finish: (bytes: Uint8Array) => void = () => undefined;
    handle.recordTurntable.mockImplementationOnce(async (_joints, onProgress) => {
      onProgress?.(0.5);
      return new Promise<Uint8Array>(resolve => {
        finish = resolve;
      });
    });
    render(engine(BUILT));
    await act(async () => byTestId('model-pane-record-btn')?.click());
    expect(byTestId('model-pane-rec-badge')?.textContent).toContain('REC 4.0 / 8 s');
    expect(byTestId('model-pane-record-btn')?.textContent).toBe('Recording 50%');
    expect(byTestId('model-pane-wireframe-btn')?.hasAttribute('disabled')).toBe(true);
    expect(byTestId('model-pane-note')?.getAttribute('role')).toBe('status');
    await act(async () => finish(new Uint8Array([1])));
    expect(byTestId('model-pane-rec-badge')).toBeNull();
    expect(byTestId('model-pane-record-btn')?.textContent).toBe('Record');
  });

  it('drives the camera and toggles from the keyboard while the view has focus', () => {
    handle.orbit.mockClear();
    handle.setView.mockClear();
    handle.zoom.mockClear();
    render(engine(BUILT));
    const stage = byTestId('model-pane-stage');
    expect(stage?.getAttribute('tabindex')).toBe('0');
    expect(stage?.getAttribute('aria-label')).toBe('chest.model.js, 3D view');
    const press = (key: string, target: Element | null | undefined = stage) =>
      act(() => {
        target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    press('ArrowLeft');
    expect(handle.orbit).toHaveBeenCalledWith(-Math.PI / 12, 0);
    press('+');
    expect(handle.zoom).toHaveBeenCalledWith(0.85);
    press('2');
    expect(handle.setView).toHaveBeenCalledWith('right');
    press('0');
    expect(handle.setView).toHaveBeenLastCalledWith(null);
    press('n');
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('night');
    expect(byTestId('model-pane-night-btn')?.getAttribute('aria-pressed')).toBe('true');
    // A key typed on a control inside the view is that control's, not a shortcut.
    press('n', byTestId('model-pane-grid-btn'));
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('night');
  });

  it('offers an exploded view only for a model with separable parts, by button and by E', () => {
    render(engine(BUILT));
    expect(byTestId('model-pane-explode-btn')).toBeNull();
    const parted = new THREE.Group();
    const lid = new THREE.Object3D();
    lid.userData.explode = [0, 0, 10];
    parted.add(lid);
    render(engine({ ...BUILT, object: parted }));
    expect(byTestId('model-pane-viewport')?.dataset.exploded).toBe('false');
    act(() => byTestId('model-pane-explode-btn')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.exploded).toBe('true');
    expect(byTestId('model-pane-explode-btn')?.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      byTestId('model-pane-stage')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true })
      );
    });
    expect(byTestId('model-pane-viewport')?.dataset.exploded).toBe('false');
  });

  it('frames a preset view from the camera menu', () => {
    handle.setView.mockClear();
    render(engine(BUILT));
    act(() => byTestId('model-pane-view-btn')?.click());
    act(() => byTestId('model-pane-view-top')?.click());
    expect(handle.setView).toHaveBeenCalledWith('top');
  });

  it('drops the highlight when another file opens', () => {
    render(engine(BUILT));
    act(() => byTestId('pick-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('lid');
    render(engine({ ...BUILT, state: { ...BUILT.state!, path: '/project/door.model.js' } }));
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('');
  });

  it('resizes from its left edge and remembers the width', () => {
    window.localStorage.removeItem('b4m.modelPane.width');
    // A desktop-sized window, so the pane's ceiling is above the drag.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
    render(engine(BUILT));
    const pane = byTestId('model-pane')!;
    const handle = byTestId('model-pane-resize-handle')!;
    expect(pane.style.width).toBe('420px');
    act(() => handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 600 })));
    act(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 500 })));
    act(() => window.dispatchEvent(new PointerEvent('pointerup', { clientX: 500 })));
    expect(pane.style.width).toBe('520px');
    expect(window.localStorage.getItem('b4m.modelPane.width')).toBe('520');
  });
});
