import * as THREE from 'three';
import type { ModelMotion } from '@shared/model3d';

/** A joint as the viewer sees it, in world space. */
export type JointDragFrame = {
  motion: ModelMotion;
  /** The point a turn spins about; unused by a slide. */
  pivot: THREE.Vector3;
  /** Unit direction a turn spins about (right-hand rule) or a slide moves along. */
  axis: THREE.Vector3;
  /** Degrees for a turn, model units for a slide. */
  range: [number, number];
  /** World length of one model unit along the axis, so a slide reads in model units. */
  scale: number;
};

/** The camera and the canvas size, in CSS px. */
export type DragViewport = { camera: THREE.Camera; width: number; height: number };

export type ScreenPoint = { x: number; y: number };

/**
 * How pointer motion becomes a value, fixed at press:
 * - `plane`: a turn whose axis faces the camera; the pointer ray meets the plane normal to the axis.
 * - `tangent`: a turn seen edge-on; pointer travel along the grab point's on-screen arc tangent.
 * - `ray`: a slide; the point on the axis line nearest the pointer ray.
 * - `screen`: a slide whose axis points at the camera; pointer travel along its screen projection.
 */
export type JointDragMode = 'plane' | 'tangent' | 'ray' | 'screen';

/** A drag in progress. `value` is the latest raw (unclamped) value; updating it is what a drag does. */
export type JointDrag = {
  mode: JointDragMode;
  value: number;
  readonly frame: JointDragFrame;
  readonly view: DragViewport;
  readonly start: number;
  readonly startPointer: ScreenPoint;
  readonly grab: THREE.Vector3;
  /** plane: the in-plane basis the angle is read in, and the last angle read, for unwrapping. */
  readonly basis?: { u: THREE.Vector3; v: THREE.Vector3 };
  lastAngle?: number;
  /** tangent and screen: the on-screen direction that increases the value, and value per px along it. */
  readonly direction?: THREE.Vector2;
  readonly perPixel?: number;
};

/** |axis . view| at or above which a turn reads the pointer in its own plane rather than along the tangent. */
const PLANE_FACING = 0.35;
/** |axis . view| above which a slide's axis is too close to the view ray for a ray-axis read (about 15 degrees). */
const SLIDE_RAY_LIMIT = Math.cos(THREE.MathUtils.degToRad(15));
/** Below this many px per unit (or per radian) a screen direction is degenerate. */
const MIN_PIXELS = 1e-3;
/** A degenerate turn falls back to screen-up travel at this many degrees per px. */
const FALLBACK_DEGREES_PER_PIXEL = 0.5;
/** A degenerate slide falls back to screen-up travel that covers its range in this many px. */
const FALLBACK_SLIDE_PIXELS = 200;
const EPSILON = 1e-9;

function pointerRay(view: DragViewport, pointer: ScreenPoint): THREE.Ray {
  const ndc = new THREE.Vector2((pointer.x / view.width) * 2 - 1, 1 - (pointer.y / view.height) * 2);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, view.camera);
  return raycaster.ray;
}

function toScreen(view: DragViewport, point: THREE.Vector3): THREE.Vector2 {
  const ndc = point.clone().project(view.camera);
  return new THREE.Vector2(((ndc.x + 1) / 2) * view.width, ((1 - ndc.y) / 2) * view.height);
}

/**
 * The screen direction `step` (a small world offset at `from`) moves a point, and px per unit of
 * `step`; null when it barely moves on screen (the offset points at the camera).
 */
function screenRate(
  view: DragViewport,
  from: THREE.Vector3,
  step: THREE.Vector3
): { direction: THREE.Vector2; pixels: number } | null {
  const size = Math.max(from.distanceTo(view.camera.position), 1) * 1e-4;
  const moved = toScreen(view, from.clone().addScaledVector(step, size)).sub(toScreen(view, from));
  const pixels = moved.length() / size;
  if (!Number.isFinite(pixels) || pixels < MIN_PIXELS * step.length()) return null;
  return { direction: moved.normalize(), pixels };
}

function span(range: [number, number]): number {
  return Math.abs(range[1] - range[0]);
}

function planeAngle(ray: THREE.Ray, frame: JointDragFrame, basis: { u: THREE.Vector3; v: THREE.Vector3 }) {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.axis, frame.pivot);
  const hit = ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return null;
  const offset = hit.sub(frame.pivot);
  if (offset.lengthSq() < EPSILON) return null;
  return THREE.MathUtils.radToDeg(Math.atan2(offset.dot(basis.v), offset.dot(basis.u)));
}

/** The parameter along the axis line through `grab` of the point nearest `ray`; null when they are parallel. */
function axisParameter(ray: THREE.Ray, grab: THREE.Vector3, axis: THREE.Vector3): number | null {
  const between = grab.clone().sub(ray.origin);
  const along = axis.dot(ray.direction);
  const denominator = 1 - along * along;
  if (denominator < EPSILON) return null;
  return (along * ray.direction.dot(between) - axis.dot(between)) / denominator;
}

/** Starts a drag of `frame` grabbed at world point `grab` under `pointer`, from the joint's value `start`. */
export function beginJointDrag(
  frame: JointDragFrame,
  view: DragViewport,
  grab: THREE.Vector3,
  pointer: ScreenPoint,
  start: number
): JointDrag {
  const base = { value: start, frame, view, start, startPointer: { ...pointer }, grab: grab.clone() };
  const toGrab = grab.clone().sub(view.camera.position).normalize();
  const facing = Math.abs(frame.axis.dot(toGrab));

  if (frame.motion === 'slide') {
    if (facing < SLIDE_RAY_LIMIT) return { ...base, mode: 'ray' };
    const rate = screenRate(view, grab, frame.axis);
    if (rate) return { ...base, mode: 'screen', direction: rate.direction, perPixel: frame.scale / rate.pixels };
    return {
      ...base,
      mode: 'screen',
      direction: new THREE.Vector2(0, -1),
      perPixel: Math.max(span(frame.range), EPSILON) / FALLBACK_SLIDE_PIXELS,
    };
  }

  if (facing >= PLANE_FACING) {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.axis, frame.pivot);
    const hit = pointerRay(view, pointer).intersectPlane(plane, new THREE.Vector3());
    const offset = hit?.sub(frame.pivot);
    if (offset && offset.lengthSq() > EPSILON) {
      const u = offset.normalize();
      const basis = { u, v: frame.axis.clone().cross(u) };
      return { ...base, mode: 'plane', basis, lastAngle: 0 };
    }
  }

  // Positive turn (right-hand rule) moves the grab point along axis x radius.
  const tangent = frame.axis.clone().cross(grab.clone().sub(frame.pivot));
  const rate = tangent.lengthSq() > EPSILON ? screenRate(view, grab, tangent) : null;
  if (rate) {
    // The tangent's length is the radius, so `pixels` is px per radian.
    return { ...base, mode: 'tangent', direction: rate.direction, perPixel: THREE.MathUtils.radToDeg(1) / rate.pixels };
  }
  return { ...base, mode: 'tangent', direction: new THREE.Vector2(0, -1), perPixel: FALLBACK_DEGREES_PER_PIXEL };
}

/** The joint's raw value with the pointer at `pointer`; also stored on `drag.value`. */
export function jointDragValue(drag: JointDrag, pointer: ScreenPoint): number {
  const { frame, view } = drag;
  if (drag.mode === 'plane' && drag.basis) {
    const angle = planeAngle(pointerRay(view, pointer), frame, drag.basis);
    // Parallel to the plane or on the pivot: hold the last value rather than jump.
    if (angle === null) return drag.value;
    const last = drag.lastAngle ?? 0;
    const delta = THREE.MathUtils.euclideanModulo(angle - last + 180, 360) - 180;
    drag.lastAngle = angle;
    drag.value += delta;
    return drag.value;
  }
  if (drag.mode === 'ray') {
    const travel = axisParameter(pointerRay(view, pointer), drag.grab, frame.axis);
    if (travel === null) return drag.value;
    drag.value = drag.start + travel / frame.scale;
    return drag.value;
  }
  const direction = drag.direction ?? new THREE.Vector2(0, -1);
  const moved = new THREE.Vector2(pointer.x - drag.startPointer.x, pointer.y - drag.startPointer.y);
  drag.value = drag.start + moved.dot(direction) * (drag.perPixel ?? 0);
  return drag.value;
}

/** How far the viewer may show a joint past its limit: 3 degrees for a turn, 2% of a slide's travel. */
export function overshootCap(motion: ModelMotion, range: [number, number]): number {
  return motion === 'turn' ? 3 : span(range) * 0.02;
}

/** Pointer overshoot, in multiples of the cap, that shows about three quarters of the cap. */
const OVERSHOOT_SOFTNESS = 4;

/**
 * `value` held to the range, and the pose to show: past a limit it overshoots with diminishing
 * returns, approaching `cap` beyond the limit (0 holds it exactly at the limit).
 */
export function softClamp(
  value: number,
  range: [number, number],
  cap: number
): { value: number; shown: number; limit: 'low' | 'high' | null } {
  const low = Math.min(range[0], range[1]);
  const high = Math.max(range[0], range[1]);
  const give = (excess: number) => (cap > 0 ? cap * Math.tanh(excess / (cap * OVERSHOOT_SOFTNESS)) : 0);
  if (value >= high && value > low) {
    return { value: high, shown: high + give(value - high), limit: 'high' };
  }
  if (value <= low) return { value: low, shown: low - give(low - value), limit: 'low' };
  return { value, shown: value, limit: null };
}

/** The snap increment: 15 degrees for a turn; for a slide the 1, 2 or 5 x 10^n step nearest a tenth of its travel. */
export function snapStep(motion: ModelMotion, range: [number, number]): number {
  if (motion === 'turn') return 15;
  const target = Math.max(span(range), EPSILON) / 10;
  const decade = 10 ** Math.floor(Math.log10(target));
  const nearest = [1, 2, 5, 10].reduce((best, factor) =>
    Math.abs(Math.log(factor * decade) - Math.log(target)) < Math.abs(Math.log(best * decade) - Math.log(target))
      ? factor
      : best
  );
  // Rounded so 0.005 is not 0.005000000000000001.
  return Number((nearest * decade).toPrecision(12));
}

/**
 * `value` on the nearest snap increment from the modelled pose, or on a limit when that is nearer
 * (a 110 degree lid snaps fully open), held to the range.
 */
export function snapValue(value: number, motion: ModelMotion, range: [number, number]): number {
  const step = snapStep(motion, range);
  const snapped = softClamp(Number((Math.round(value / step) * step).toPrecision(12)), range, 0).value;
  return [...range, snapped].reduce((best, target) =>
    Math.abs(target - value) < Math.abs(best - value) ? target : best
  );
}

/** One arrow-key nudge: a degree or a hundredth of the travel, or the snap step when `big`. */
export function nudgeStep(motion: ModelMotion, range: [number, number], big: boolean): number {
  if (big) return snapStep(motion, range);
  return motion === 'turn' ? 1 : span(range) / 100;
}
