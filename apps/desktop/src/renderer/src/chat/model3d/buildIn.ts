import * as THREE from 'three';

/** How long one part takes to print in, in ms. */
const PART_MS = 650;
/** The most the whole build may take to start its last part, in ms, however many parts there are. */
const STAGGER_BUDGET_MS = 1100;
/** The longest gap between one part starting and the next, in ms. */
const MAX_STAGGER_MS = 160;
/** The warm glow at the edge being printed, faded out as each part finishes. */
const GLOW = new THREE.Color('#ff9a3c');
const GLOW_STRENGTH = 0.4;

/** The names of the meshes (parts) under `root`. */
function partNames(root: THREE.Object3D): Set<string> {
  const names = new Set<string>();
  root.traverse(node => {
    if (node instanceof THREE.Mesh && node.name) names.add(node.name);
  });
  return names;
}

/** The parts `next` has that `previous` does not: every part when there is nothing to compare with. */
export function newPartNames(previous: THREE.Object3D | null, next: THREE.Object3D): Set<string> {
  const after = partNames(next);
  if (!previous) return after;
  const before = partNames(previous);
  return new Set([...after].filter(name => !before.has(name)));
}

type Printing = {
  material: THREE.MeshStandardMaterial;
  plane: THREE.Plane;
  bottom: number;
  top: number;
  start: number;
  emissive: THREE.Color;
  done: boolean;
};

/** A running build: `step` advances it to `now` and says whether any part is still printing. */
export type BuildIn = { step: (now: number) => boolean; finish: () => void };

/**
 * Prints the parts of `root` named in `names` into view, as the agent adds them: each part is
 * revealed from the bottom up by a rising clip plane, with a warm glow that fades as it completes,
 * lowest part first. Clipping, not moving, so it composes with joint poses and the exploded view.
 * Needs `renderer.localClippingEnabled`. Null when none of the names is a part of `root`.
 */
export function startBuildIn(root: THREE.Object3D, names: ReadonlySet<string>, now: number): BuildIn | null {
  root.updateMatrixWorld(true);
  const parts: { mesh: THREE.Mesh; box: THREE.Box3 }[] = [];
  root.traverse(node => {
    if (node instanceof THREE.Mesh && names.has(node.name) && node.material instanceof THREE.MeshStandardMaterial) {
      const box = new THREE.Box3().setFromObject(node);
      if (!box.isEmpty()) parts.push({ mesh: node, box });
    }
  });
  if (!parts.length) return null;
  parts.sort((a, b) => a.box.min.y - b.box.min.y);
  const stagger = Math.min(MAX_STAGGER_MS, STAGGER_BUDGET_MS / parts.length);
  const printing: Printing[] = parts.map(({ mesh, box }, index) => {
    const material = mesh.material as THREE.MeshStandardMaterial;
    // A tiny margin, so nothing of the part shows before it starts or stays cut once it ends.
    const margin = (box.max.y - box.min.y) * 0.01 + 1e-6;
    // Keeps what is below the plane: a downward normal clips where -y + constant < 0.
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), box.min.y - margin);
    material.clippingPlanes = [plane];
    material.clipShadows = true;
    material.needsUpdate = true;
    return {
      material,
      plane,
      bottom: box.min.y - margin,
      top: box.max.y + margin,
      start: now + index * stagger,
      emissive: material.emissive.clone(),
      done: false,
    };
  });
  const complete = (part: Printing) => {
    part.material.clippingPlanes = null;
    part.material.emissive.copy(part.emissive);
    part.material.needsUpdate = true;
    part.done = true;
  };
  return {
    step: now => {
      for (const part of printing) {
        if (part.done) continue;
        const t = THREE.MathUtils.clamp((now - part.start) / PART_MS, 0, 1);
        if (t >= 1) {
          complete(part);
          continue;
        }
        const eased = 1 - (1 - t) ** 3;
        part.plane.constant = THREE.MathUtils.lerp(part.bottom, part.top, eased);
        part.material.emissive.copy(part.emissive).lerp(GLOW, t > 0 ? GLOW_STRENGTH * (1 - t) : 0);
      }
      return printing.some(part => !part.done);
    },
    finish: () => printing.filter(part => !part.done).forEach(complete),
  };
}
