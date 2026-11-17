import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  addMeasurePoint,
  featureEdges,
  formatLength,
  measureResult,
  snapPoint,
  stillOnSurface,
  type MeasurePoint,
} from './measure';

// A flat projection: 10 px per world unit on x and y, depth ignored.
const toScreen = (world: THREE.Vector3) => new THREE.Vector2(world.x * 10, world.y * 10);
const edge = new THREE.Line3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0));

const at = (x: number, y: number, z = 0): MeasurePoint => ({
  point: new THREE.Vector3(x, y, z),
  normal: new THREE.Vector3(0, 0, 1),
  kind: 'surface',
});

describe('snapPoint', () => {
  it('snaps to a corner within the vertex radius', () => {
    const hit = new THREE.Vector3(0.5, 0.5, 0);
    const snapped = snapPoint(hit, toScreen(hit), [edge], toScreen);
    expect(snapped.kind).toBe('vertex');
    expect(snapped.point.toArray()).toEqual([0, 0, 0]);
  });

  it('snaps onto an edge away from its corners', () => {
    const hit = new THREE.Vector3(5, 0.4, 0);
    const snapped = snapPoint(hit, toScreen(hit), [edge], toScreen);
    expect(snapped.kind).toBe('edge');
    expect(snapped.point.toArray()).toEqual([5, 0, 0]);
  });

  it('keeps the surface hit when nothing is close', () => {
    const hit = new THREE.Vector3(5, 3, 0);
    const snapped = snapPoint(hit, toScreen(hit), [edge], toScreen);
    expect(snapped.kind).toBe('surface');
    expect(snapped.point).not.toBe(hit);
    expect(snapped.point.toArray()).toEqual([5, 3, 0]);
  });

  it('prefers the nearest of several corners', () => {
    const other = new THREE.Line3(new THREE.Vector3(0.6, 0, 0), new THREE.Vector3(0.6, 5, 0));
    const hit = new THREE.Vector3(0.5, 0.1, 0);
    expect(snapPoint(hit, toScreen(hit), [edge, other], toScreen).point.toArray()).toEqual([0.6, 0, 0]);
  });
});

describe('featureEdges', () => {
  it('finds a box outline in world space without the face diagonals', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    mesh.position.set(10, 0, 0);
    const edges = featureEdges(mesh);
    expect(edges).toHaveLength(12);
    for (const line of edges) {
      expect(line.distance()).toBeCloseTo(2);
      expect(line.start.x).toBeGreaterThanOrEqual(9 - 1e-9);
    }
  });
});

describe('measurement', () => {
  it('starts afresh after two points', () => {
    const two = addMeasurePoint(addMeasurePoint([], at(0, 0)), at(3, 4));
    expect(two).toHaveLength(2);
    expect(addMeasurePoint(two, at(1, 1))).toHaveLength(1);
  });

  it('measures the distance and the run along each model axis', () => {
    expect(measureResult([at(0, 0).point])).toBeNull();
    // World y is the model's z (up); world z is the model's -y.
    const result = measureResult([at(1, 2, 3).point, at(4, -2, 3).point]);
    expect(result?.distance).toBeCloseTo(5);
    expect(result?.delta).toEqual([3, 0, 4]);
    expect(measureResult([at(0, 0, 0).point, at(0, 0, -7).point])?.delta).toEqual([0, 7, 0]);
  });

  it('formats lengths with sensible precision', () => {
    expect(formatLength(0)).toBe('0');
    expect(formatLength(123.456)).toBe('123.5');
    expect(formatLength(12.5)).toBe('12.5');
    expect(formatLength(2)).toBe('2');
    expect(formatLength(0.0456)).toBe('0.0456');
  });
});

describe('stillOnSurface', () => {
  it('tells whether a picked point is still on the rebuilt model', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)));
    root.updateMatrixWorld(true);
    expect(stillOnSurface(root, at(0, 0, 1), 0.01)).toBe(true);
    expect(stillOnSurface(root, at(0, 0, 1.5), 0.01)).toBe(false);
  });
});
