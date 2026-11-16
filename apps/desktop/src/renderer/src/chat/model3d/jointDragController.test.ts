// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelPartMesh } from '@shared/model3d';
import { CLICK_SLOP, JointDragController } from './jointDragController';
import { jointDragFrame, buildModelObject } from './modelScene';

const WIDTH = 800;
const HEIGHT = 600;

/** A box from (0, 0, `lift`) up to (x, y, `lift` + z). */
function box(name: string, x: number, y: number, z: number, lift = 0): ModelPartMesh {
  const top = lift + z;
  const positions = new Float32Array([
    0,
    0,
    lift,
    x,
    0,
    lift,
    x,
    y,
    lift,
    0,
    y,
    lift,
    0,
    0,
    top,
    x,
    0,
    top,
    x,
    y,
    top,
    0,
    y,
    top,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { name, color: '#8b5a2b', positions, indices };
}

/** A body with a lid sat on it and hinged along its back edge about model X, in world space (no Z-up wrapper rotation). */
const JOINTED: ModelPartMesh[] = [
  box('body', 60, 40, 30),
  { ...box('lid', 60, 40, 10, 30), pivot: [0, 40, 30], parent: 'body', axis: [-1, 0, 0], range: [0, 90] },
];

type Rig = {
  controller: JointDragController;
  host: HTMLDivElement;
  canvas: HTMLCanvasElement;
  controls: { enabled: boolean };
  root: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  pose: Record<string, number>;
  onChange: ReturnType<typeof vi.fn>;
  onStart: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  enabled: { value: boolean };
  /** Where a world point shows, in client px (the canvas sits at the origin). */
  screenOf(point: THREE.Vector3): { x: number; y: number };
  /** The lid's end face centre, in the hinge's own plane: the camera looks along the hinge axis at it. */
  grab: THREE.Vector3;
  /** Where `grab` shows once the lid is turned `degrees` open. */
  grabAt(degrees: number): { x: number; y: number };
  /** Runs the queued animation frames, a frame every 50 ms from well past any tween's start. */
  settleFrames(): void;
};

let rigs: Rig[] = [];
let frames: FrameRequestCallback[] = [];

function makeRig(parts: ModelPartMesh[] = JOINTED): Rig {
  const root = buildModelObject(parts, 'mm');
  root.getObjectByName('model')!.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const lid = root.getObjectByName('lid');
  const target = new THREE.Box3().setFromObject(lid ?? root);
  const centre = target.getCenter(new THREE.Vector3());
  const grab = new THREE.Vector3(target.min.x, centre.y, centre.z);
  const camera = new THREE.PerspectiveCamera(35, WIDTH / HEIGHT, 0.1, 5000);
  camera.position.set(grab.x - 300, grab.y, grab.z);
  camera.lookAt(grab);
  camera.updateMatrixWorld(true);

  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, HEIGHT);
  host.appendChild(canvas);
  document.body.appendChild(host);

  const screenOf = (point: THREE.Vector3) => {
    const ndc = point.clone().project(camera);
    return { x: ((ndc.x + 1) / 2) * WIDTH, y: ((1 - ndc.y) / 2) * HEIGHT };
  };
  const pose: Record<string, number> = { lid: 0 };
  const controls = { enabled: true };
  const onChange = vi.fn((name: string, value: number) => {
    pose[name] = value;
  });
  const onStart = vi.fn();
  const render = vi.fn();
  const enabled = { value: true };
  const scene = new THREE.Scene();
  scene.add(root);
  const controller = new JointDragController({
    host,
    canvas,
    camera,
    controls: controls as OrbitControls,
    scene,
    shown: () => root,
    pose: () => pose,
    enabled: () => enabled.value,
    onChange,
    onStart,
    render,
  });
  const rig: Rig = {
    controller,
    host,
    canvas,
    controls,
    root,
    camera,
    pose,
    onChange,
    onStart,
    render,
    enabled,
    screenOf,
    grab,
    grabAt: degrees => {
      const frame = jointDragFrame(root.getObjectByName('lid')!);
      const turned = grab
        .clone()
        .sub(frame.pivot)
        .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(frame.axis, THREE.MathUtils.degToRad(degrees)))
        .add(frame.pivot);
      return screenOf(turned);
    },
    settleFrames: () => {
      const start = performance.now() + 1000;
      for (let tick = 0; tick < 200 && frames.length; tick++) {
        const queued = frames;
        frames = [];
        for (const frame of queued) frame(start + tick * 50);
      }
    },
  };
  rigs.push(rig);
  return rig;
}

function fire(
  target: EventTarget,
  type: string,
  at: { x: number; y: number },
  init: { pointerId?: number; button?: number; buttons?: number; shiftKey?: boolean } = {}
) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
    pointerId: init.pointerId ?? 1,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0,
    shiftKey: init.shiftKey ?? false,
  });
  target.dispatchEvent(event);
  return event;
}

const down = (rig: Rig, at: { x: number; y: number }, init = {}) =>
  fire(rig.canvas, 'pointerdown', at, { buttons: 1, ...init });
const move = (rig: Rig, at: { x: number; y: number }, init = {}) =>
  fire(rig.canvas, 'pointermove', at, { buttons: 1, ...init });
const up = (rig: Rig, at: { x: number; y: number }, init = {}) => fire(rig.canvas, 'pointerup', at, init);

function key(type: 'keydown' | 'keyup', name: string) {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

/** Presses the lid and drags it open by `degrees`, leaving the button down. */
function dragTo(rig: Rig, degrees: number, init = {}) {
  down(rig, rig.screenOf(rig.grab));
  move(rig, rig.grabAt(degrees), init);
}

const lastValue = (rig: Rig) => rig.onChange.mock.calls.at(-1)?.[1] as number;

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  for (const rig of rigs) {
    rig.controller.dispose();
    rig.host.remove();
  }
  rigs = [];
  vi.unstubAllGlobals();
});

describe('JointDragController', () => {
  it('claims the press from the orbit controls and gives it back on release', () => {
    const rig = makeRig();
    down(rig, rig.screenOf(rig.grab));
    expect(rig.controls.enabled).toBe(false);
    up(rig, rig.screenOf(rig.grab));
    expect(rig.controls.enabled).toBe(true);
  });

  it('turns the joint under the pointer past the click slop and keeps it within its range', () => {
    const rig = makeRig();
    dragTo(rig, 30);
    expect(rig.onStart).toHaveBeenCalledTimes(1);
    expect(lastValue(rig)).toBeCloseTo(30, 0);
    expect(rig.controller.busy).toBe(true);
    expect(rig.canvas.style.cursor).toBe('grabbing');
    move(rig, rig.grabAt(60));
    expect(lastValue(rig)).toBeCloseTo(60, 0);
    for (const [, value] of rig.onChange.mock.calls) expect(value).toBeGreaterThanOrEqual(0);
    for (const [, value] of rig.onChange.mock.calls) expect(value).toBeLessThanOrEqual(90);
  });

  it('keeps a drag from reaching the viewer as a click, but lets a click through', () => {
    const rig = makeRig();
    const picked = vi.fn();
    rig.canvas.addEventListener('pointerup', picked);

    const at = rig.screenOf(rig.grab);
    down(rig, at);
    move(rig, { x: at.x + CLICK_SLOP - 1, y: at.y });
    up(rig, at);
    expect(picked).toHaveBeenCalledTimes(1);
    expect(rig.onStart).not.toHaveBeenCalled();
    expect(rig.onChange).not.toHaveBeenCalled();

    dragTo(rig, 30);
    up(rig, rig.grabAt(30));
    expect(picked).toHaveBeenCalledTimes(1);
  });

  it('shows an overshoot past a limit and eases it back on release', () => {
    const rig = makeRig();
    dragTo(rig, 130);
    expect(lastValue(rig)).toBe(90);
    expect(rig.controller.posed(rig.pose).lid).toBeGreaterThan(90);
    up(rig, rig.grabAt(130));
    rig.settleFrames();
    expect(rig.controller.posed(rig.pose)).toBe(rig.pose);
    expect(rig.controller.busy).toBe(false);
  });

  it('snaps to 15 degrees while Shift is held', () => {
    const rig = makeRig();
    dragTo(rig, 35, { shiftKey: true });
    expect(lastValue(rig)).toBe(30);
  });

  it('reverts to the press value on Escape and ignores the rest of the press', () => {
    const rig = makeRig();
    dragTo(rig, 40);
    const escape = key('keydown', 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(lastValue(rig)).toBe(0);
    const calls = rig.onChange.mock.calls.length;
    move(rig, rig.grabAt(70));
    expect(rig.onChange).toHaveBeenCalledTimes(calls);

    const picked = vi.fn();
    rig.canvas.addEventListener('pointerup', picked);
    rig.render.mockClear();
    up(rig, rig.grabAt(70));
    expect(picked).not.toHaveBeenCalled();
    expect(rig.controls.enabled).toBe(true);
    // The AO pass was held back while the button was down; the release draws the settled frame.
    expect(rig.render).toHaveBeenCalled();
  });

  it('leaves Escape alone when nothing is being dragged', () => {
    const rig = makeRig();
    expect(key('keydown', 'Escape').defaultPrevented).toBe(false);
    down(rig, rig.screenOf(rig.grab));
    expect(key('keydown', 'Escape').defaultPrevented).toBe(false);
  });

  it('shows the grab cursor and the guide over a movable part, and hides them over empty space', () => {
    const rig = makeRig();
    fire(rig.canvas, 'pointermove', rig.screenOf(rig.grab));
    rig.settleFrames();
    expect(rig.canvas.style.cursor).toBe('grab');
    expect(rig.controller.overlay.visible).toBe(true);

    fire(rig.canvas, 'pointermove', { x: 5, y: 5 });
    rig.settleFrames();
    expect(rig.canvas.style.cursor).toBe('');
    expect(rig.controller.overlay.visible).toBe(false);
  });

  it('hides the guide after a drag that began without a hover', () => {
    const rig = makeRig();
    dragTo(rig, 30);
    up(rig, rig.grabAt(30));
    rig.settleFrames();
    expect(rig.controller.overlay.visible).toBe(false);
  });

  describe('when a press should do nothing', () => {
    it('ignores the middle and right buttons', () => {
      const rig = makeRig();
      down(rig, rig.screenOf(rig.grab), { button: 2 });
      expect(rig.controls.enabled).toBe(true);
      move(rig, rig.grabAt(30));
      expect(rig.onStart).not.toHaveBeenCalled();
    });

    it('ignores a press while something else owns the view', () => {
      const rig = makeRig();
      rig.enabled.value = false;
      down(rig, rig.screenOf(rig.grab));
      expect(rig.controls.enabled).toBe(true);
      move(rig, rig.grabAt(30));
      expect(rig.onStart).not.toHaveBeenCalled();
    });

    it('leaves a fixed part to the orbit controls', () => {
      const rig = makeRig([box('slab', 60, 40, 30)]);
      down(rig, rig.screenOf(rig.grab));
      expect(rig.controls.enabled).toBe(true);
    });

    it('leaves empty space to the orbit controls', () => {
      const rig = makeRig();
      down(rig, { x: 5, y: 5 });
      expect(rig.controls.enabled).toBe(true);
    });

    it('ignores a second pointer while one is dragging', () => {
      const rig = makeRig();
      dragTo(rig, 30);
      const calls = rig.onChange.mock.calls.length;
      move(rig, rig.grabAt(60), { pointerId: 2 });
      down(rig, rig.grabAt(60), { pointerId: 2 });
      up(rig, rig.grabAt(60), { pointerId: 2 });
      expect(rig.onChange).toHaveBeenCalledTimes(calls);
      expect(rig.controller.busy).toBe(true);
      expect(rig.controls.enabled).toBe(false);
    });
  });

  describe('when a drag is cut short', () => {
    it('ends on pointercancel and hands the view back', () => {
      const rig = makeRig();
      dragTo(rig, 30);
      fire(rig.canvas, 'pointercancel', rig.grabAt(30));
      expect(rig.controls.enabled).toBe(true);
      const calls = rig.onChange.mock.calls.length;
      move(rig, rig.grabAt(60));
      expect(rig.onChange).toHaveBeenCalledTimes(calls);
      rig.settleFrames();
      expect(rig.controller.busy).toBe(false);
    });

    it('drops the drag when the model is replaced', () => {
      const rig = makeRig();
      dragTo(rig, 130);
      rig.controller.reset();
      expect(rig.controls.enabled).toBe(true);
      expect(rig.controller.posed(rig.pose)).toBe(rig.pose);
      const calls = rig.onChange.mock.calls.length;
      move(rig, rig.grabAt(60));
      expect(rig.onChange).toHaveBeenCalledTimes(calls);
    });

    it('stops listening once disposed', () => {
      const rig = makeRig();
      rig.controller.dispose();
      down(rig, rig.screenOf(rig.grab));
      expect(rig.controls.enabled).toBe(true);
    });
  });
});
