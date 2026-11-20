import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ModelJoint } from '@shared/model3d';
import { orbitShot, swing, turntableCamera, turntableMimeType, turntablePose, turntableScript } from './turntable';

const lid: ModelJoint = { name: 'lid', motion: 'turn', axis: [1, 0, 0], range: [0, 100] };
const drawer: ModelJoint = { name: 'drawer', motion: 'slide', axis: [0, 0, 1], range: [-20, 0] };

describe('swing', () => {
  it('starts and ends at rest and peaks halfway, so the clip loops', () => {
    expect(swing(0)).toBeCloseTo(0);
    expect(swing(0.5)).toBeCloseTo(1);
    expect(swing(1)).toBeCloseTo(0);
    expect(swing(-1)).toBeCloseTo(0);
  });
});

describe('turntableScript', () => {
  it('swings the joints in the first half and explodes the parts in the second', () => {
    expect(turntableScript(0)).toEqual({ joints: 0, explode: 0 });
    expect(turntableScript(0.25)).toEqual({ joints: 0.5, explode: 0 });
    expect(turntableScript(0.5).joints).toBe(1);
    expect(turntableScript(0.5).explode).toBeCloseTo(0);
    expect(turntableScript(0.75).explode).toBeCloseTo(1);
    expect(turntableScript(1).explode).toBeCloseTo(0);
  });
});

describe('turntablePose', () => {
  it('swings each joint from where it was left to its far end and back', () => {
    expect(turntablePose([lid, drawer], { lid: 0, drawer: 0 }, 0)).toEqual({ lid: 0, drawer: 0 });
    const peak = turntablePose([lid, drawer], { lid: 0, drawer: 0 }, 0.5);
    expect(peak.lid).toBeCloseTo(100);
    expect(peak.drawer).toBeCloseTo(-20);
  });

  it('swings a joint left near its top end back towards the bottom', () => {
    expect(turntablePose([lid], { lid: 90 }, 0.5).lid).toBeCloseTo(0);
  });

  it('clamps a start outside the range and treats a missing one as 0', () => {
    expect(turntablePose([lid], { lid: 400 }, 0).lid).toBe(100);
    expect(turntablePose([drawer], {}, 0).drawer).toBe(0);
  });
});

describe('orbitShot', () => {
  const camera = new THREE.PerspectiveCamera(30, 16 / 9);
  const corners = (shot: { target: THREE.Vector3; distance: number }, box: THREE.Box3, azimuth: number) => {
    camera.position.setFromSphericalCoords(shot.distance, 1, azimuth).add(shot.target);
    camera.lookAt(shot.target);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return [0, 1, 2, 3, 4, 5, 6, 7].map(corner =>
      new THREE.Vector3(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z
      ).project(camera)
    );
  };

  it('aims at the box centre and keeps every corner in frame all the way round', () => {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(200, 20, 40));
    plank.position.set(50, 10, 0);
    const shot = orbitShot(camera, plank, new THREE.Vector3(0, 0.5, 1));
    expect(shot.target.toArray()).toEqual([50, 10, 0]);
    const box = new THREE.Box3().setFromObject(plank);
    for (const azimuth of [0, 0.7, 1.6, 2.9, 4.4]) {
      for (const corner of corners(shot, box, azimuth)) {
        expect(Math.abs(corner.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(corner.y)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fills the frame tighter than a bounding sphere would', () => {
    const plank = new THREE.Mesh(new THREE.BoxGeometry(200, 20, 40));
    const shot = orbitShot(camera, plank, new THREE.Vector3(0, 0.5, 1));
    const sphere = new THREE.Box3().setFromObject(plank).getBoundingSphere(new THREE.Sphere());
    expect(shot.distance).toBeLessThan(sphere.radius / Math.sin(THREE.MathUtils.degToRad(15)));
  });
});

describe('turntableCamera', () => {
  const shots = {
    direction: new THREE.Vector3(0, 1, 2).normalize(),
    closed: { target: new THREE.Vector3(0, 10, 0), distance: 100 },
    open: { target: new THREE.Vector3(0, 14, 0), distance: 120 },
    exploded: { target: new THREE.Vector3(0, 20, 0), distance: 160 },
  };

  it('starts and ends on the closed shot, so the clip loops', () => {
    const start = turntableCamera(shots, 0);
    const end = turntableCamera(shots, 1);
    expect(start.distance).toBeCloseTo(100);
    expect(start.position.distanceTo(end.position)).toBeCloseTo(0);
    expect(start.position.distanceTo(new THREE.Vector3(0, 10, 0))).toBeCloseTo(100);
  });

  it('frames the open joints, then pulls back to fit the exploded parts', () => {
    expect(turntableCamera(shots, 0.25).distance).toBeCloseTo(120);
    expect(turntableCamera(shots, 0.25).target.y).toBeCloseTo(14);
    const exploded = turntableCamera(shots, 0.75);
    expect(exploded.distance).toBeCloseTo(160);
    expect(exploded.target.y).toBeCloseTo(20);
  });

  it('turns half way round the model at the midpoint', () => {
    const half = turntableCamera(shots, 0.5);
    expect(half.position.z).toBeLessThan(0);
  });
});

describe('turntableMimeType', () => {
  it('prefers VP9 and falls back to plain WebM', () => {
    expect(turntableMimeType(() => true)).toBe('video/webm;codecs=vp9');
    expect(turntableMimeType(type => type === 'video/webm')).toBe('video/webm');
    expect(turntableMimeType(() => false)).toBeNull();
  });
});
