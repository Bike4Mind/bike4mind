import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { ModelJoint } from '@shared/model3d';
import { orbitShot, swing, turntableCamera, turntableMimeType, turntablePose, turntableScript } from './turntable';
import { newPartNames, startBuildIn } from './buildIn';
import { changedParts, EDIT_FLASH_MS, startEditFlash } from './editFlash';

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

describe('buildIn', () => {
  function part(name: string, y: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial());
    mesh.name = name;
    mesh.position.y = y;
    return mesh;
  }

  function model(...parts: THREE.Mesh[]): THREE.Group {
    const root = new THREE.Group();
    root.add(...parts);
    return root;
  }

  describe('newPartNames', () => {
    it('names only the parts the new model adds', () => {
      const before = model(part('body', 0), part('lid', 10));
      const after = model(part('body', 0), part('lid', 10), part('lock', 5));
      expect([...newPartNames(before, after)]).toEqual(['lock']);
      expect(newPartNames(after, after).size).toBe(0);
    });

    it('names every part when there is nothing to compare with', () => {
      expect([...newPartNames(null, model(part('body', 0), part('lid', 10)))].sort()).toEqual(['body', 'lid']);
    });
  });

  describe('startBuildIn', () => {
    it('prints the named parts up from the bottom, lowest first, then leaves them as they were', () => {
      const body = part('body', 0);
      const lid = part('lid', 10);
      const material = lid.material as THREE.MeshStandardMaterial;
      const root = model(lid, body);
      const build = startBuildIn(root, new Set(['body', 'lid']), 0);
      expect(build).not.toBeNull();
      const bodyPlane = (body.material as THREE.MeshStandardMaterial).clippingPlanes?.[0];
      const lidPlane = material.clippingPlanes?.[0];
      // Nothing shows before a part starts: the plane sits at its bottom.
      expect(lidPlane?.constant).toBeLessThanOrEqual(5);
      expect(build?.step(300)).toBe(true);
      expect(bodyPlane?.constant).toBeGreaterThan(-5);
      // The lid sits higher, so it starts later and is less far along.
      expect((lidPlane?.constant ?? 0) - 5).toBeLessThan((bodyPlane?.constant ?? 0) + 5);
      expect(material.emissive.getHex()).not.toBe(0);
      expect(build?.step(5000)).toBe(false);
      expect(material.clippingPlanes).toBeNull();
      expect(material.emissive.getHex()).toBe(0);
    });

    it('leaves other parts alone and does nothing without a named part', () => {
      const body = part('body', 0);
      const root = model(body, part('lid', 10));
      expect(startBuildIn(root, new Set(['lock']), 0)).toBeNull();
      const build = startBuildIn(root, new Set(['lid']), 0);
      expect((body.material as THREE.MeshStandardMaterial).clippingPlanes).toBeNull();
      build?.finish();
      expect(build?.step(0)).toBe(false);
    });
  });
});

describe('editFlash', () => {
  function part(name: string, size: number, color = '#888888'): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color }));
    mesh.name = name;
    return mesh;
  }

  function model(...parts: THREE.Mesh[]): THREE.Group {
    const root = new THREE.Group();
    root.add(...parts);
    return root;
  }

  describe('changedParts', () => {
    it('names only the picked parts whose shape or material changed', () => {
      const before = model(part('lid', 2), part('body', 4), part('handle', 1));
      const after = model(part('lid', 3), part('body', 4), part('handle', 1, '#b5862b'));
      expect(changedParts(before, after, ['lid', 'body', 'handle'])).toEqual(['lid', 'handle']);
      expect(changedParts(before, after, ['body'])).toEqual([]);
    });

    it('leaves out a part that is missing from either build', () => {
      expect(changedParts(model(part('lid', 2)), model(part('cap', 2)), ['lid'])).toEqual([]);
    });
  });

  describe('startEditFlash', () => {
    it('ghosts the old shape, glows the new one, and cleans both up when done', () => {
      const previous = model(part('lid', 2), part('body', 4));
      const shown = model(part('lid', 3), part('body', 4));
      const parent = new THREE.Group();
      parent.add(shown);
      const lid = shown.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      const flash = startEditFlash(parent, shown, previous, ['lid'], 0, false);
      expect(parent.children).toHaveLength(2);
      const ghost = parent.children[1];
      const visible: string[] = [];
      ghost.traverse(node => node instanceof THREE.Mesh && node.visible && visible.push(node.name));
      expect(visible).toEqual(['lid']);
      expect(lid.material.emissiveIntensity).toBeGreaterThan(0.5);

      expect(flash?.step(EDIT_FLASH_MS / 2)).toBe(true);
      expect(flash?.step(EDIT_FLASH_MS)).toBe(false);
      expect(parent.children).toEqual([shown]);
      expect(lid.material.emissive.getHex()).toBe(0);
      expect(lid.material.emissiveIntensity).toBe(1);
    });

    it('holds still under reduced motion, without fading', () => {
      const shown = model(part('lid', 3));
      const parent = model();
      parent.add(shown);
      const flash = startEditFlash(parent, shown, model(part('lid', 2)), ['lid'], 0, true);
      const ghost = parent.children[1].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      const opacity = ghost.material.opacity;
      flash?.step(EDIT_FLASH_MS / 2);
      expect(ghost.material.opacity).toBe(opacity);
    });
  });
});
