// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_STATE } from '@shared/model3d';
import type { ModelEngine } from './model3d/useModelEngine';
import { MODEL_EXAMPLE_PROMPTS, ModelPane } from './ModelPane';

// jsdom has no WebGL; the viewport is covered by the live app, not here.
vi.mock('./model3d/ModelViewport', () => ({
  ModelViewport: ({
    dimmed,
    pose,
    picked,
    onPick,
  }: {
    dimmed: boolean;
    pose: Record<string, number>;
    picked: string | null;
    onPick: (name: string | null) => void;
  }) => (
    <div
      data-testid="model-pane-viewport"
      data-dimmed={String(dimmed)}
      data-pose={JSON.stringify(pose)}
      data-picked={picked ?? ''}
    >
      <button data-testid="pick-lid" onClick={() => onPick('lid')} />
      <button data-testid="pick-none" onClick={() => onPick(null)} />
    </div>
  ),
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

const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

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
    expect(byTestId('model-pane-export-stl-btn')?.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the last good model dimmed under the error', () => {
    render(engine({ ...BUILT, status: 'error', error: { message: 'width is not defined', line: 7 } }));
    expect(byTestId('model-pane-error')?.textContent).toBe('Line 7: width is not defined');
    expect(byTestId('model-pane-viewport')?.dataset.dimmed).toBe('true');
    expect(byTestId('model-pane-export-glb-btn')?.hasAttribute('disabled')).toBe(false);
  });

  it('says which params could not be written back', () => {
    render(engine({ ...BUILT, unsaved: ['width'] }));
    expect(byTestId('model-pane-unsaved')?.textContent).toContain('width');
  });

  it('exports and reports where the file went', async () => {
    const model = engine(BUILT);
    render(model);
    await act(async () => byTestId('model-pane-export-glb-btn')?.click());
    expect(model.exportFile).toHaveBeenCalledWith('glb');
    expect(byTestId('model-pane-export-note')?.textContent).toBe('Saved chest.glb');
  });

  it('only offers STL for model files, since a loaded asset has no source parts', () => {
    render(engine({ ...BUILT, state: { ...BUILT.state!, path: '/project/chest.glb', kind: 'glb' }, params: {} }));
    expect(byTestId('model-pane-export-stl-btn')?.hasAttribute('disabled')).toBe(true);
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
