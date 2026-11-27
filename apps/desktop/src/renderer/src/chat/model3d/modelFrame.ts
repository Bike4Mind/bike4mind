import * as THREE from 'three';

/**
 * A model file is Z-up; the scene is Y-up, so buildModelScene turns the model -90 degrees about X
 * (modelScene.ts): model (x, y, z) sits at world (x, z, -y). Anything the user reads as an axis
 * (the section axes, the measure readout) speaks the model's axes, not the scene's.
 */
export type ModelAxis = 'x' | 'y' | 'z';

const WORLD_DIRECTION: Record<ModelAxis, readonly [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 0, -1],
  z: [0, 1, 0],
};

/** The world-space unit vector along a model axis. */
export function worldDirection(axis: ModelAxis, target = new THREE.Vector3()): THREE.Vector3 {
  return target.fromArray(WORLD_DIRECTION[axis]);
}

/** A world-space vector (a direction or a difference of points) in model axes. */
export function toModelFrame(world: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(world.x, -world.z, world.y);
}
