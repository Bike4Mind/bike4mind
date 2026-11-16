import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { changedParts, EDIT_FLASH_MS, startEditFlash } from './editFlash';

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
