import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { newPartNames, startBuildIn } from './buildIn';

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
