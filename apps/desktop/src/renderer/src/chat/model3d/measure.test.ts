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
import {
  clampOffset,
  DEFAULT_SECTION,
  flipped,
  keptBy,
  sectionPlane,
  sectionPosition,
  setClipPlane,
  withAxis,
  withOffset,
} from './section';
import { latestOnly } from './latestOnly';

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

describe('snap radii', () => {
  it('snaps to a corner at 9 px but not at 11 px', () => {
    const near = new THREE.Vector3(0.9, 0, 0);
    expect(snapPoint(near, toScreen(near), [edge], toScreen).kind).toBe('vertex');
    const far = new THREE.Vector3(1.1, 0, 0);
    expect(snapPoint(far, toScreen(far), [edge], toScreen).kind).not.toBe('vertex');
  });

  it('snaps to an edge at 6 px but not at 8 px', () => {
    const near = new THREE.Vector3(5, 0.6, 0);
    expect(snapPoint(near, toScreen(near), [edge], toScreen).kind).toBe('edge');
    const far = new THREE.Vector3(5, 0.8, 0);
    expect(snapPoint(far, toScreen(far), [edge], toScreen).kind).toBe('surface');
  });
});

describe('featureEdges', () => {
  // Two triangles sharing the x axis from 0 to 1, their normals `degrees` apart.
  const hinge = (degrees: number) => {
    const t = THREE.MathUtils.degToRad(degrees);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, -Math.cos(t), Math.sin(t)], 3)
    );
    return featureEdges(new THREE.Mesh(geometry)).filter(
      line => line.start.y === 0 && line.start.z === 0 && line.end.y === 0 && line.end.z === 0
    );
  };

  it('keeps a 25 degree crease and drops a 15 degree one', () => {
    expect(hinge(25)).toHaveLength(1);
    expect(hinge(15)).toHaveLength(0);
  });

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

describe('section', () => {
  // World-space bounds: the model's z is world y and its y is world -z (modelFrame.ts).
  const box = new THREE.Box3(new THREE.Vector3(-10, 0, 100), new THREE.Vector3(30, 20, 110));

  describe('sectionPosition', () => {
    it('places the cut its share of the way across the chosen model axis', () => {
      expect(sectionPosition({ axis: 'x', offset: 0.25, flipped: false }, box)).toBe(0);
      expect(sectionPosition({ axis: 'y', offset: 1, flipped: false }, box)).toBe(-100);
      expect(sectionPosition({ axis: 'z', offset: 0, flipped: true }, box)).toBe(0);
    });
  });

  describe('sectionPlane', () => {
    it('keeps the low side of the axis unless flipped', () => {
      const plane = sectionPlane({ axis: 'x', offset: 0.5, flipped: false }, box);
      expect(keptBy(plane, new THREE.Vector3(0, 10, 105))).toBe(true);
      expect(keptBy(plane, new THREE.Vector3(20, 10, 105))).toBe(false);
      const other = sectionPlane({ axis: 'x', offset: 0.5, flipped: true }, box);
      expect(keptBy(other, new THREE.Vector3(0, 10, 105))).toBe(false);
      expect(keptBy(other, new THREE.Vector3(20, 10, 105))).toBe(true);
    });

    it("cuts the model's z (up) across the world y", () => {
      const plane = sectionPlane({ axis: 'z', offset: 0.3, flipped: false }, box);
      expect(plane.normal.y).toBe(-1);
      expect(Math.abs(plane.normal.x) + Math.abs(plane.normal.z)).toBe(0);
      expect(plane.distanceToPoint(new THREE.Vector3(5, 6, 103))).toBeCloseTo(0);
      expect(keptBy(plane, new THREE.Vector3(5, 2, 103))).toBe(true);
    });

    it("cuts the model's y across the world z, keeping its low side", () => {
      const plane = sectionPlane({ axis: 'y', offset: 0.5, flipped: false }, box);
      expect(plane.distanceToPoint(new THREE.Vector3(0, 10, 105))).toBeCloseTo(0);
      expect(keptBy(plane, new THREE.Vector3(0, 10, 108))).toBe(true);
      expect(keptBy(plane, new THREE.Vector3(0, 10, 102))).toBe(false);
    });

    it('writes into a given plane', () => {
      const target = new THREE.Plane();
      expect(sectionPlane(DEFAULT_SECTION, box, target)).toBe(target);
    });
  });

  describe('section state', () => {
    it('clamps the offset and falls back to the middle', () => {
      expect(clampOffset(-1)).toBe(0);
      expect(clampOffset(2)).toBe(1);
      expect(clampOffset(Number.NaN)).toBe(0.5);
      expect(withOffset(DEFAULT_SECTION, 1.5).offset).toBe(1);
    });

    it('changes axis and flips without touching the rest', () => {
      const state = { axis: 'x' as const, offset: 0.2, flipped: false };
      expect(withAxis(state, 'y')).toEqual({ axis: 'y', offset: 0.2, flipped: false });
      expect(flipped(state)).toEqual({ axis: 'x', offset: 0.2, flipped: true });
      expect(flipped(flipped(state))).toEqual(state);
    });

    it('keeps everything when there is no plane', () => {
      expect(keptBy(null, new THREE.Vector3(1e6, 0, 0))).toBe(true);
    });
  });

  describe('setClipPlane', () => {
    it('adds and removes its plane beside a build-in plane', () => {
      const material = new THREE.MeshStandardMaterial();
      const build = new THREE.Plane();
      const cut = new THREE.Plane();
      setClipPlane(material, build, true);
      setClipPlane(material, cut, true);
      setClipPlane(material, cut, true);
      expect(material.clippingPlanes).toEqual([build, cut]);
      expect(material.clipShadows).toBe(true);
      setClipPlane(material, build, false);
      expect(material.clippingPlanes).toEqual([cut]);
      setClipPlane(material, cut, false);
      expect(material.clippingPlanes).toBeNull();
    });
  });
});

describe('latestOnly', () => {
  function gatedJob() {
    const runs: Array<() => void> = [];
    const job = () => new Promise<void>(resolve => runs.push(resolve));
    return { job, runs };
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  describe('latestOnly', () => {
    it('runs at once when idle', () => {
      const { job, runs } = gatedJob();
      latestOnly(job)();
      expect(runs).toHaveLength(1);
    });

    it('collapses every call made during a run into one follow-up run', async () => {
      const { job, runs } = gatedJob();
      const trigger = latestOnly(job);
      trigger();
      for (let index = 0; index < 30; index += 1) trigger();
      expect(runs).toHaveLength(1);
      runs[0]();
      await settle();
      expect(runs).toHaveLength(2);
      runs[1]();
      await settle();
      expect(runs).toHaveLength(2);
    });
  });
});
