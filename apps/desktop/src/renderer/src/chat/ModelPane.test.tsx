// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_STATE } from '@shared/model3d';
import type { ModelEngine } from './model3d/useModelEngine';
import type { ModelViewportHandle } from './model3d/ModelViewport';
import { buildModelObject } from './model3d/modelScene';
import { MODEL_EXAMPLE_PROMPTS, ModelPane, type PartEditTurn } from './ModelPane';

const handle = vi.hoisted(() => ({
  recordTurntable: vi.fn<ModelViewportHandle['recordTurntable']>(async () => new Uint8Array([1, 2, 3])),
  setView: vi.fn(),
  fit: vi.fn(),
  orbit: vi.fn(),
  zoom: vi.fn(),
  partPoint: vi.fn(() => ({ x: 60, y: 50 })),
}));

const closeup = vi.hoisted(() => vi.fn(async () => new Uint8Array([9, 9])));
// The close-up renders with WebGL, which jsdom lacks; its framing is the live app's to check.
vi.mock('./model3d/modelScene', async importOriginal => ({
  ...(await importOriginal<typeof import('./model3d/modelScene')>()),
  renderPartCloseup: closeup,
}));

// jsdom has no WebGL; the viewport is covered by the live app, not here.
vi.mock('./model3d/ModelViewport', () => ({
  ModelViewport: ({
    dimmed,
    lighting,
    pose,
    picked,
    editing,
    onPick,
    onPoseChange,
    onJointDragStart,
    clip,
    exploded,
    onCroppedChange,
    handleRef,
  }: {
    dimmed: boolean;
    lighting: string;
    pose: Record<string, number>;
    picked: readonly string[];
    editing: readonly string[];
    onPick: (pick: { name: string | null; additive: boolean; point: { x: number; y: number } }) => void;
    onPoseChange?: (name: string, value: number) => void;
    onJointDragStart?: () => void;
    clip: string | null;
    exploded: boolean;
    onCroppedChange?: (cropped: boolean) => void;
    handleRef?: { current: unknown };
  }) => {
    if (handleRef) handleRef.current = handle;
    return (
      <div
        data-testid="model-pane-viewport"
        data-dimmed={String(dimmed)}
        data-lighting={lighting}
        data-pose={JSON.stringify(pose)}
        data-picked={picked.join(',')}
        data-editing={editing.join(',')}
        data-clip={clip ?? ''}
        data-exploded={String(exploded)}
      >
        <button
          data-testid="pick-lid"
          onClick={event => onPick({ name: 'lid', additive: event.shiftKey, point: { x: 40, y: 30 } })}
        />
        <button
          data-testid="pick-body"
          onClick={event => onPick({ name: 'body', additive: event.shiftKey, point: { x: 20, y: 30 } })}
        />
        <button
          data-testid="drag-lid"
          onClick={() => {
            onJointDragStart?.();
            onPoseChange?.('lid', 55);
          }}
        />
        <button data-testid="report-cropped" onClick={() => onCroppedChange?.(true)} />
        <button data-testid="report-in-view" onClick={() => onCroppedChange?.(false)} />
        <button
          data-testid="pick-none"
          onClick={() => onPick({ name: null, additive: false, point: { x: 0, y: 0 } })}
        />
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
    sessionId: 'chat-a',
    state: EMPTY_MODEL_STATE,
    status: 'idle',
    error: null,
    object: null,
    summary: null,
    parts: [],
    params: {},
    unsaved: [],
    joints: [],
    jointAngles: {},
    clips: [],
    setJointAngles: vi.fn(),
    previewParam: vi.fn(),
    commitParam: vi.fn(async () => {}),
    exportFile: vi.fn(async () => '/project/chest.glb'),
    saveRecording: vi.fn(async () => null),
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
  props: {
    onClose?: () => void;
    onExamplePrompt?: (text: string) => void;
    onSendEdit?: (edit: PartEditTurn) => Promise<boolean>;
    replying?: boolean;
  } = {}
) {
  act(() =>
    root.render(
      <CssVarsProvider>
        <ModelPane
          engine={model}
          dark={false}
          onClose={props.onClose ?? (() => {})}
          onExamplePrompt={props.onExamplePrompt ?? (() => {})}
          onSendEdit={props.onSendEdit ?? (async () => true)}
          replying={props.replying}
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

  it('announces each build state in a polite live region that stays mounted', () => {
    render(engine({ ...BUILT, status: 'building' }));
    const announcer = byTestId('model-pane-announcer');
    expect(announcer?.getAttribute('aria-live')).toBe('polite');
    expect(announcer?.textContent).toBe('Building the model.');
    render(engine(BUILT));
    expect(byTestId('model-pane-announcer')).toBe(announcer);
    expect(announcer?.textContent).toBe('Model built.');
    render(engine({ ...BUILT, status: 'error', error: { message: 'width is not defined', line: 7 } }));
    expect(announcer?.textContent).toBe('Model build failed at line 7: width is not defined');
  });

  it('reads a timeout, which has no line number, as a plain failure with its reason', () => {
    const message = 'Build stopped after 5 s without finishing.';
    render(engine({ ...BUILT, status: 'error', error: { message } }));
    expect(byTestId('model-pane-announcer')?.textContent).toBe(`Model build failed: ${message}`);
    expect(byTestId('model-pane-error')?.textContent).toBe(message);
  });

  it('keeps the last good model dimmed under the error', () => {
    render(engine({ ...BUILT, status: 'error', error: { message: 'width is not defined', line: 7 } }));
    expect(byTestId('model-pane-error')?.textContent).toBe('Line 7: width is not defined');
    expect(byTestId('model-pane-viewport')?.dataset.dimmed).toBe('true');
    expect(byTestId('model-pane-export-btn')?.hasAttribute('disabled')).toBe(false);
    // A clip of the dimmed stale model would pass for the broken one.
    expect(byTestId('model-pane-record-btn')?.hasAttribute('disabled')).toBe(true);
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

  describe('moving a joint from the view', () => {
    const lidJoint = {
      name: 'lid',
      motion: 'turn' as const,
      axis: [-1, 0, 0] as [number, number, number],
      range: [0, 90] as [number, number],
    };
    /** A body with a lid hinged on it and a fixed handle on the lid, as the engine builds them. */
    const hinged = () => {
      const cube = (name: string) => ({
        name,
        color: '#8b5a2b',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
      });
      return buildModelObject(
        [
          cube('body'),
          { ...cube('lid'), pivot: [0, 1, 1], parent: 'body', axis: lidJoint.axis, range: lidJoint.range },
          { ...cube('handle'), parent: 'lid' },
        ],
        'mm'
      );
    };
    const pressKey = (key: string, shiftKey = false) =>
      act(() => {
        byTestId('model-pane-stage')?.dispatchEvent(
          new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
        );
      });

    it('nudges a picked moving part with the arrows and announces the value', () => {
      handle.orbit.mockClear();
      const setJointAngles = vi.fn();
      render(engine({ ...BUILT, object: hinged(), joints: [lidJoint], jointAngles: { lid: 40 }, setJointAngles }));
      act(() => byTestId('pick-lid')?.click());
      pressKey('ArrowRight');
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: 41 });
      expect(byTestId('model-pane-joint-announcer')?.textContent).toBe('lid 41\u00b0');
      // The engine feeds the new angles back before the next key.
      render(engine({ ...BUILT, object: hinged(), joints: [lidJoint], jointAngles: { lid: 41 }, setJointAngles }));
      pressKey('ArrowDown', true);
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: 26 });
      expect(handle.orbit).not.toHaveBeenCalled();
    });

    it('opens a joint whose range runs downwards with Right and Up', () => {
      const setJointAngles = vi.fn();
      const joints = [{ ...lidJoint, range: [0, -110] as [number, number] }];
      render(engine({ ...BUILT, object: hinged(), joints, jointAngles: { lid: -40 }, setJointAngles }));
      act(() => byTestId('pick-lid')?.click());
      pressKey('ArrowRight');
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: -41 });
      pressKey('ArrowLeft');
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: -39 });
    });

    it('holds a nudge at the end of the range', () => {
      const setJointAngles = vi.fn();
      render(engine({ ...BUILT, object: hinged(), joints: [lidJoint], jointAngles: { lid: 89.5 }, setJointAngles }));
      act(() => byTestId('pick-lid')?.click());
      pressKey('ArrowUp', true);
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: 90 });
    });

    it('still orbits with a fixed part picked', () => {
      handle.orbit.mockClear();
      const setJointAngles = vi.fn();
      render(engine({ ...BUILT, object: hinged(), joints: [lidJoint], setJointAngles }));
      act(() => byTestId('pick-body')?.click());
      pressKey('ArrowLeft');
      expect(handle.orbit).toHaveBeenCalledWith(-Math.PI / 12, 0);
      expect(setJointAngles).not.toHaveBeenCalled();
    });

    it('moves the sliders with a drag and stops playback', () => {
      const setJointAngles = vi.fn();
      render(engine({ ...BUILT, object: hinged(), joints: [lidJoint], jointAngles: { lid: 10 }, setJointAngles }));
      act(() => byTestId('model-pane-joints-play-btn')?.click());
      expect(byTestId('model-pane-joints-play-btn')?.textContent).toBe('Stop');
      act(() => byTestId('drag-lid')?.click());
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: 55 });
      expect(byTestId('model-pane-joints-play-btn')?.textContent).toBe('Play');
    });

    it('keeps the other joints when a drag moves one', () => {
      const setJointAngles = vi.fn();
      const flap = { ...lidJoint, name: 'flap', range: [0, 45] as [number, number] };
      render(
        engine({
          ...BUILT,
          object: hinged(),
          joints: [lidJoint, flap],
          jointAngles: { lid: 10, flap: 5 },
          setJointAngles,
        })
      );
      act(() => byTestId('drag-lid')?.click());
      expect(setJointAngles).toHaveBeenLastCalledWith({ lid: 55, flap: 5 });
    });

    it('does not start playing on the next jointed model after the joints went away', () => {
      const joints = [lidJoint];
      render(engine({ ...BUILT, object: hinged(), joints, jointAngles: { lid: 10 } }));
      act(() => byTestId('model-pane-joints-play-btn')?.click());
      expect(byTestId('model-pane-joints-play-btn')?.textContent).toBe('Stop');
      render(engine({ ...BUILT }));
      expect(byTestId('model-pane-joints')).toBeNull();
      render(engine({ ...BUILT, object: hinged(), joints, jointAngles: { lid: 10 } }));
      expect(byTestId('model-pane-joints-play-btn')?.textContent).toBe('Play');
    });
  });

  const LANTERN_PARTS: ModelEngine['parts'] = [
    { name: 'body', lines: [3], min: [0, 0, 0], max: [60, 40, 20] },
    { name: 'lid', lines: [4], min: [0, 0, 20], max: [60, 40, 30] },
  ];
  const LANTERN = {
    ...BUILT,
    state: {
      ...BUILT.state!,
      source:
        "export default function model({ m }) {\n  return [\n    { name: 'body', shape: a },\n    { name: 'lid', shape: b },\n  ];\n}",
    },
    summary: { ...BUILT.summary!, parts: ['body', 'lid'] },
    parts: LANTERN_PARTS,
  };

  const typeInto = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const press = (target: HTMLElement, key: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });

  it('opens an edit prompt on a clicked part and sends the change tied to it', async () => {
    const onSendEdit = vi.fn(async (_edit: PartEditTurn) => true);
    render(engine(LANTERN), { onSendEdit });
    expect(byTestId('model-pane-size')?.textContent).toContain('click a part to edit it');
    act(() => byTestId('pick-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('lid');
    expect(byTestId('model-pane-edit-parts')?.textContent).toBe('lid');
    const input = byTestId('model-pane-edit-input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Describe a change to lid');
    typeInto(input, 'make it brass');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSendEdit).toHaveBeenCalledTimes(1);
    const edit = onSendEdit.mock.calls[0][0];
    expect(edit.text).toBe('make it brass');
    expect(edit.closeup).toEqual({ name: 'model-edit-lid.png', bytes: new Uint8Array([9, 9]) });
    expect(closeup).toHaveBeenCalledWith(LANTERN.object, ['lid'], false, {});
    const note = edit.note(true);
    expect(note).toContain('Parts: ["lid"]');
    expect(note).toContain('in /project/chest.model.js');
    expect(note).toContain('- lid: listed at line 4; built by lines 4; bounds x 0..60, y 0..40, z 20..30 mm');
    expect(note).toContain('Close-up: model-edit-lid.png');
    expect(edit.note(false)).not.toContain('Close-up');
    // Sent: the prompt and the selection clear.
    expect(byTestId('model-pane-edit-prompt')).toBeNull();
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('');
  });

  it('forgets a sent edit once its turn ends, so a later rebuild does not flash it', async () => {
    render(engine(LANTERN));
    act(() => byTestId('pick-lid')?.click());
    const input = byTestId('model-pane-edit-input') as HTMLInputElement;
    typeInto(input, 'make it brass');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const editing = () => byTestId('model-pane-viewport')?.dataset.editing;
    // Not yet: the turn has not been seen open.
    expect(editing()).toBe('lid');
    render(engine(LANTERN), { replying: true });
    expect(editing()).toBe('lid');
    render(engine(LANTERN), { replying: false });
    expect(editing()).toBe('');
  });

  it('adds parts with shift-click, and Escape or empty space clears without sending', () => {
    const onSendEdit = vi.fn(async () => true);
    render(engine(LANTERN), { onSendEdit });
    act(() => byTestId('pick-lid')?.click());
    act(() => byTestId('pick-body')?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('lid,body');
    expect(byTestId('model-pane-edit-parts')?.textContent).toBe('lid and body');
    press(byTestId('model-pane-edit-input') as HTMLElement, 'Escape');
    expect(byTestId('model-pane-edit-prompt')).toBeNull();
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('');
    act(() => byTestId('pick-lid')?.click());
    act(() => byTestId('pick-none')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('');
    expect(onSendEdit).not.toHaveBeenCalled();
  });

  it('picks parts from the keyboard and opens the prompt with Enter', () => {
    render(engine(LANTERN));
    const stage = byTestId('model-pane-stage') as HTMLElement;
    press(stage, ']');
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('body');
    press(stage, ']');
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('lid');
    expect(byTestId('model-pane-edit-prompt')).toBeNull();
    press(stage, 'Enter');
    expect(handle.partPoint).toHaveBeenCalledWith(['lid']);
    expect(byTestId('model-pane-edit-prompt')).not.toBeNull();
    expect(document.activeElement).toBe(byTestId('model-pane-edit-input'));
  });

  it('highlights a part of an opened GLB without offering an edit', () => {
    render(
      engine({
        ...LANTERN,
        state: { path: '/project/chest.glb', kind: 'glb', generation: 3, source: null, missing: false },
      })
    );
    act(() => byTestId('pick-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.picked).toBe('lid');
    expect(byTestId('model-pane-edit-prompt')).toBeNull();
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

  it('picks a lighting preset from the lighting menu', () => {
    render(engine(BUILT));
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('studio');
    act(() => byTestId('model-pane-lighting-btn')?.click());
    act(() => byTestId('model-pane-lighting-sunset')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('sunset');
    act(() => byTestId('model-pane-lighting-btn')?.click());
    expect(byTestId('model-pane-lighting-sunset')?.getAttribute('aria-checked')).toBe('true');
    act(() => byTestId('model-pane-lighting-studio')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('studio');
  });

  it('records a turntable of the joints, stops playback first, and saves it as WebM', async () => {
    const saveRecording = vi.fn(async () => '/project/chest-turntable.webm');
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
      saveRecording,
    };
    render(engine(glb));
    act(() => byTestId('model-pane-clip-lid')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('lid');
    await act(async () => byTestId('model-pane-record-btn')?.click());
    expect(byTestId('model-pane-viewport')?.dataset.clip).toBe('');
    expect(handle.recordTurntable).toHaveBeenCalledWith(joints, expect.any(Function));
    expect(saveRecording).toHaveBeenCalledWith('chat-a', new Uint8Array([1, 2, 3]));
    expect(byTestId('model-pane-note')?.textContent).toBe('Saved chest-turntable.webm');
  });

  it('shows recording progress on the view and the button while a turntable records', async () => {
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
    press('l');
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('sunset');
    press('n');
    expect(byTestId('model-pane-viewport')?.dataset.lighting).toBe('night');
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

  it('offers a fit once the model grows past a placed camera, by button and by F', () => {
    handle.fit.mockClear();
    render(engine(BUILT));
    expect(byTestId('model-pane-fit-btn')).toBeNull();
    act(() => byTestId('report-cropped')?.click());
    act(() => byTestId('model-pane-fit-btn')?.click());
    expect(handle.fit).toHaveBeenCalledTimes(1);
    act(() => {
      byTestId('model-pane-stage')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true })
      );
    });
    expect(handle.fit).toHaveBeenCalledTimes(2);
    act(() => byTestId('report-in-view')?.click());
    expect(byTestId('model-pane-fit-btn')).toBeNull();
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
