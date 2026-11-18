import * as THREE from 'three';
import { worldDirection, type ModelAxis } from './modelFrame';

/** In the model's own (Z-up) axes; see modelFrame.ts. */
export type SectionAxis = ModelAxis;

export const SECTION_AXES: readonly SectionAxis[] = ['x', 'y', 'z'];

/**
 * One cutting plane across the model: square to `axis`, `offset` of the way across the model's
 * bounds (0..1), keeping the low side of the axis, or the high side when `flipped`.
 */
export type SectionState = { axis: SectionAxis; offset: number; flipped: boolean };

export const DEFAULT_SECTION: SectionState = { axis: 'x', offset: 0.5, flipped: false };

/** Pulls an offset back into 0..1; anything not a finite number cuts through the middle. */
export function clampOffset(offset: number): number {
  return Number.isFinite(offset) ? THREE.MathUtils.clamp(offset, 0, 1) : 0.5;
}

/**
 * Where the plane crosses its axis, in world units along the axis' world direction, for a model
 * filling the world-space `box`.
 */
export function sectionPosition(state: SectionState, box: THREE.Box3): number {
  const direction = worldDirection(state.axis);
  const ends = [direction.dot(box.min), direction.dot(box.max)];
  const low = Math.min(...ends);
  const high = Math.max(...ends);
  return low + (high - low) * clampOffset(state.offset);
}

/**
 * The clip plane for `state` across `box`. three keeps what is on the plane's positive side
 * (normal . p + constant >= 0), so an unflipped cut faces down the axis and keeps the low side.
 */
export function sectionPlane(state: SectionState, box: THREE.Box3, target = new THREE.Plane()): THREE.Plane {
  const normal = worldDirection(state.axis).multiplyScalar(state.flipped ? 1 : -1);
  const position = sectionPosition(state, box);
  return target.set(normal, state.flipped ? -position : position);
}

/** The state after picking another axis: the cut stays as far across the new axis. */
export function withAxis(state: SectionState, axis: SectionAxis): SectionState {
  return { ...state, axis };
}

export function withOffset(state: SectionState, offset: number): SectionState {
  return { ...state, offset: clampOffset(offset) };
}

export function flipped(state: SectionState): SectionState {
  return { ...state, flipped: !state.flipped };
}

/** True when `point` is on the side of `plane` that is kept (drawn and pickable). */
export function keptBy(plane: THREE.Plane | null, point: THREE.Vector3): boolean {
  return !plane || plane.distanceToPoint(point) >= 0;
}

/**
 * Adds `plane` to the material's clip planes, or takes it out, leaving any other plane (a part
 * printing in, buildIn.ts) where it is. No planes at all is null, as three expects.
 */
export function setClipPlane(material: THREE.Material, plane: THREE.Plane, on: boolean): void {
  const others = (material.clippingPlanes ?? []).filter(entry => entry !== plane);
  const next = on ? [...others, plane] : others;
  const before = material.clippingPlanes?.length ?? 0;
  material.clippingPlanes = next.length ? next : null;
  if (on) material.clipShadows = true;
  if (before !== next.length) material.needsUpdate = true;
}
