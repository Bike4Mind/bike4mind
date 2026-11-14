import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  beginJointDrag,
  jointDragValue,
  nudgeStep,
  overshootCap,
  snapStep,
  snapValue,
  softClamp,
  type DragViewport,
  type JointDragFrame,
} from './jointDrag';

const WIDTH = 800;
const HEIGHT = 600;

/** A camera at `position` looking at the origin, with its matrices current. */
function viewFrom(position: [number, number, number], up: [number, number, number] = [0, 1, 0]): DragViewport {
  const camera = new THREE.PerspectiveCamera(35, WIDTH / HEIGHT, 0.01, 1000);
  camera.position.set(...position);
  camera.up.set(...up);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { camera, width: WIDTH, height: HEIGHT };
}

/** Where a world point shows on screen, in CSS px from the top left. */
function screenOf(view: DragViewport, point: THREE.Vector3): { x: number; y: number } {
  const ndc = point.clone().project(view.camera);
  return { x: ((ndc.x + 1) / 2) * view.width, y: ((1 - ndc.y) / 2) * view.height };
}

function hinge(axis: [number, number, number], range: [number, number] = [-180, 180]): JointDragFrame {
  return { motion: 'turn', pivot: new THREE.Vector3(), axis: new THREE.Vector3(...axis).normalize(), range, scale: 1 };
}

function slide(axis: [number, number, number], range: [number, number] = [0, 40], scale = 1): JointDragFrame {
  return { motion: 'slide', pivot: new THREE.Vector3(), axis: new THREE.Vector3(...axis).normalize(), range, scale };
}

describe('hinge drag', () => {
  it('keeps the grabbed point under the cursor when the hinge faces the camera', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(10, 0, 0);
    const drag = beginJointDrag(hinge([0, 0, 1]), view, grab, screenOf(view, grab), 0);
    expect(drag.mode).toBe('plane');
    // A quarter turn about +Z (right-hand rule) carries +X to +Y.
    expect(jointDragValue(drag, screenOf(view, new THREE.Vector3(0, 10, 0)))).toBeCloseTo(90, 0);
  });

  it('turns the other way about a reversed axis', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(10, 0, 0);
    const drag = beginJointDrag(hinge([0, 0, -1]), view, grab, screenOf(view, grab), 0);
    expect(jointDragValue(drag, screenOf(view, new THREE.Vector3(0, 10, 0)))).toBeCloseTo(-90, 0);
  });

  it('accumulates past half a turn instead of wrapping', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(10, 0, 0);
    const drag = beginJointDrag(hinge([0, 0, 1]), view, grab, screenOf(view, grab), 0);
    for (const degrees of [60, 120, 180, 240]) {
      const radians = THREE.MathUtils.degToRad(degrees);
      jointDragValue(drag, screenOf(view, new THREE.Vector3(10 * Math.cos(radians), 10 * Math.sin(radians), 0)));
    }
    expect(drag.value).toBeCloseTo(240, 0);
  });

  it('starts from the value at press', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(10, 0, 0);
    const drag = beginJointDrag(hinge([0, 0, 1]), view, grab, screenOf(view, grab), 30);
    expect(jointDragValue(drag, screenOf(view, grab))).toBeCloseTo(30, 5);
  });

  it('follows the arc tangent when the hinge is edge-on to the view', () => {
    // Looking down -Z at a hinge about +Y: its plane is edge-on, so a ray-plane hit is useless.
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(0, 0, 10);
    const drag = beginJointDrag(hinge([0, 1, 0]), view, grab, screenOf(view, grab), 0);
    expect(drag.mode).toBe('tangent');
    // About +Y, a point on +Z moves towards +X: a small turn shows as a move right on screen.
    const turned = new THREE.Vector3(10 * Math.sin(0.1), 0, 10 * Math.cos(0.1));
    const value = jointDragValue(drag, screenOf(view, turned));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeCloseTo(THREE.MathUtils.radToDeg(0.1), 0);
  });

  it('stays finite with the axis exactly along the view ray', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(5, 5, 0);
    const drag = beginJointDrag(hinge([0, 0, 1]), view, grab, screenOf(view, grab), 0);
    const value = jointDragValue(drag, { x: WIDTH / 2 - 120, y: HEIGHT / 2 + 40 });
    expect(Number.isFinite(value)).toBe(true);
  });

  it('stays finite when the press lands on the axis', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(0, 0, 0);
    // Edge-on and grabbed on the axis: no tangent to follow.
    const drag = beginJointDrag(hinge([0, 1, 0]), view, grab, screenOf(view, grab), 0);
    const value = jointDragValue(drag, { x: WIDTH / 2, y: HEIGHT / 2 - 50 });
    expect(Number.isFinite(value)).toBe(true);
    expect(value).not.toBe(0);
  });
});

describe('slide drag', () => {
  it('maps the pointer to the travel under it along the axis', () => {
    const view = viewFrom([30, 40, 100]);
    const grab = new THREE.Vector3(0, 0, 0);
    const drag = beginJointDrag(slide([1, 0, 0]), view, grab, screenOf(view, grab), 0);
    expect(drag.mode).toBe('ray');
    expect(jointDragValue(drag, screenOf(view, new THREE.Vector3(25, 0, 0)))).toBeCloseTo(25, 1);
  });

  it('measures travel in model units when the world is scaled', () => {
    const view = viewFrom([30, 40, 100]);
    const grab = new THREE.Vector3(0, 0, 0);
    const drag = beginJointDrag(slide([1, 0, 0], [0, 40], 0.5), view, grab, screenOf(view, grab), 0);
    expect(jointDragValue(drag, screenOf(view, new THREE.Vector3(10, 0, 0)))).toBeCloseTo(20, 1);
  });

  it('falls back to screen travel when the axis points at the camera', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(0, 0, 0);
    const drag = beginJointDrag(slide([0, 0, 1]), view, grab, screenOf(view, grab), 0);
    expect(drag.mode).toBe('screen');
    const value = jointDragValue(drag, { x: WIDTH / 2, y: HEIGHT / 2 - 60 });
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  it('follows the screen projection of an axis close to the view ray', () => {
    const view = viewFrom([0, 0, 100]);
    const grab = new THREE.Vector3(0, 0, 0);
    // About 8 degrees off the view ray: past the ray-axis cutoff, yet with a usable screen direction.
    const drag = beginJointDrag(slide([0.14, 0, 1]), view, grab, screenOf(view, grab), 0);
    expect(drag.mode).toBe('screen');
    const toward = jointDragValue(drag, screenOf(view, new THREE.Vector3(1.4, 0, 10)));
    // Linear in screen travel, so perspective makes it approximate: about 10 units, not exactly.
    expect(toward).toBeGreaterThan(8);
    expect(toward).toBeLessThan(12);
  });
});

describe('softClamp', () => {
  it('passes a value inside the range through', () => {
    expect(softClamp(20, [0, 110], 3)).toEqual({ value: 20, shown: 20, limit: null });
  });

  it('clamps the value and overshoots the shown pose a little, never past the cap', () => {
    const near = softClamp(112, [0, 110], 3);
    expect(near.value).toBe(110);
    expect(near.limit).toBe('high');
    expect(near.shown).toBeGreaterThan(110);
    expect(near.shown).toBeLessThan(112);
    expect(softClamp(1000, [0, 110], 3).shown).toBeLessThanOrEqual(113);
    expect(softClamp(-50, [0, 110], 3)).toMatchObject({ value: 0, limit: 'low' });
    expect(softClamp(-50, [0, 110], 3).shown).toBeGreaterThanOrEqual(-3);
  });

  it('holds exactly at the limit without overshoot', () => {
    expect(softClamp(130, [0, 110], 0)).toEqual({ value: 110, shown: 110, limit: 'high' });
  });

  it('reads a range given high to low', () => {
    expect(softClamp(-10, [110, 0], 0)).toEqual({ value: 0, shown: 0, limit: 'low' });
    expect(softClamp(50, [110, 0], 0).limit).toBeNull();
  });

  it('caps overshoot at 3 degrees for a turn and 2% of the travel for a slide', () => {
    expect(overshootCap('turn', [0, 110])).toBe(3);
    expect(overshootCap('slide', [0, 40])).toBeCloseTo(0.8, 5);
  });
});

describe('snapping', () => {
  it('snaps a turn to 15 degrees', () => {
    expect(snapStep('turn', [0, 110])).toBe(15);
    expect(snapValue(22, 'turn', [0, 110])).toBe(15);
    expect(snapValue(23, 'turn', [0, 110])).toBe(30);
    expect(snapValue(109, 'turn', [0, 110])).toBe(110);
  });

  it('snaps a slide to the round step nearest a tenth of its travel', () => {
    expect(snapStep('slide', [0, 40])).toBe(5);
    expect(snapStep('slide', [0, 10])).toBe(1);
    expect(snapStep('slide', [0, 0.04])).toBeCloseTo(0.005, 10);
    expect(snapValue(7.4, 'slide', [0, 40])).toBe(5);
    expect(snapValue(38, 'slide', [0, 40])).toBe(40);
  });

  it('nudges by a degree or a hundredth of the travel, and by the snap step when big', () => {
    expect(nudgeStep('turn', [0, 110], false)).toBe(1);
    expect(nudgeStep('turn', [0, 110], true)).toBe(15);
    expect(nudgeStep('slide', [0, 40], false)).toBeCloseTo(0.4, 10);
    expect(nudgeStep('slide', [0, 40], true)).toBe(5);
  });
});
