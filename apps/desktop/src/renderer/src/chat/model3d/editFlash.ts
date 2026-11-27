import * as THREE from 'three';

/** How long the before/after moment lasts after a point-and-edit rebuild, in ms. */
export const EDIT_FLASH_MS = 1400;
/** The old shape's ghost starts this opaque and fades to nothing. */
const GHOST_OPACITY = 0.38;
const GHOST_COLOR = new THREE.Color('#9fb4cc');
/** The edited part glows in the pick colour, then settles back to its own. */
const FLASH_GLOW = new THREE.Color('#2f7cf6');
const FLASH_STRENGTH = 0.55;

function meshesNamed(root: THREE.Object3D, name: string): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse(node => {
    if (node instanceof THREE.Mesh && node.name === name) meshes.push(node);
  });
  return meshes;
}

/** A cheap fingerprint of a part: its vertex data, placement and look. */
function partSignature(root: THREE.Object3D, name: string): string | null {
  const meshes = meshesNamed(root, name);
  if (!meshes.length) return null;
  root.updateMatrixWorld(true);
  return meshes
    .map(mesh => {
      const position = mesh.geometry.getAttribute('position');
      const box = new THREE.Box3().setFromObject(mesh);
      const material = mesh.material as THREE.MeshStandardMaterial;
      let sum = 0;
      for (let index = 0; index < position.count * position.itemSize; index += 1) {
        sum += (position.array[index] as number) * ((index % 7) + 1);
      }
      return [
        position.count,
        sum.toFixed(3),
        box.min
          .toArray()
          .map(value => value.toFixed(4))
          .join(','),
        box.max
          .toArray()
          .map(value => value.toFixed(4))
          .join(','),
        material.color?.getHexString() ?? '',
        material.metalness ?? '',
        material.roughness ?? '',
        material.map?.uuid ?? '',
      ].join('|');
    })
    .join(';');
}

/**
 * The parts among `names` whose shape, placement or material differs between two builds: what a
 * point-and-edit turn actually changed. A part missing from either build is left out.
 */
export function changedParts(previous: THREE.Object3D, next: THREE.Object3D, names: readonly string[]): string[] {
  return names.filter(name => {
    const before = partSignature(previous, name);
    const after = partSignature(next, name);
    return before !== null && after !== null && before !== after;
  });
}

export type EditFlash = {
  /** Advances to `now`; false once it is over and everything is back as it was. */
  step: (now: number) => boolean;
  finish: () => void;
};

/**
 * The before/after moment for an edited part: a translucent ghost of its old shape (taken from
 * `previous`, posed like `shown`) fades out while the new shape glows and settles. With `still`
 * (reduced motion) both are held unchanged for the same time, then removed, with no fade.
 * The ghost is added under `parent`, which must share `shown`'s transform.
 */
export function startEditFlash(
  parent: THREE.Object3D,
  shown: THREE.Object3D,
  previous: THREE.Object3D,
  names: readonly string[],
  now: number,
  still: boolean
): EditFlash | null {
  if (!names.length) return null;
  const ghost = previous.clone(true);
  ghost.position.copy(shown.position);
  ghost.quaternion.copy(shown.quaternion);
  ghost.scale.copy(shown.scale);
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR,
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
    wireframe: true,
  });
  ghost.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    node.visible = names.includes(node.name);
    node.material = ghostMaterial;
    node.castShadow = false;
    node.receiveShadow = false;
  });
  parent.add(ghost);

  const glowing = names
    .flatMap(name => meshesNamed(shown, name))
    .flatMap(mesh => {
      const material = mesh.material;
      if (!(material instanceof THREE.MeshStandardMaterial)) return [];
      return [{ material, emissive: material.emissive.clone(), intensity: material.emissiveIntensity }];
    });
  const glow = (strength: number) => {
    for (const entry of glowing) {
      entry.material.emissive.copy(entry.emissive).lerp(FLASH_GLOW, strength);
      entry.material.emissiveIntensity = entry.intensity + (FLASH_STRENGTH - entry.intensity) * strength;
    }
  };

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    parent.remove(ghost);
    ghostMaterial.dispose();
    for (const entry of glowing) {
      entry.material.emissive.copy(entry.emissive);
      entry.material.emissiveIntensity = entry.intensity;
    }
  };
  glow(1);
  return {
    step: (time: number) => {
      if (done) return false;
      const t = Math.min(1, (time - now) / EDIT_FLASH_MS);
      if (t >= 1) {
        finish();
        return false;
      }
      if (!still) {
        const fade = 1 - t * t;
        ghostMaterial.opacity = GHOST_OPACITY * fade;
        glow(fade);
      }
      return true;
    },
    finish,
  };
}
