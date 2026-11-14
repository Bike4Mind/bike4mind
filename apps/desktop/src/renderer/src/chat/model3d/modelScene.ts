import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  describeJoints,
  type ModelJoint,
  type ModelKind,
  type ModelParam,
  type ModelPartMesh,
  type ModelSummary,
  type ModelUnits,
  type ModelView,
} from '@shared/model3d';
import { enableShadows, ModelComposer, ModelStage } from './modelStage';
import { applyTexture, boxProjectUvs } from './proceduralTextures';

/**
 * three.js side of the model pane: meshes from the sandboxed engine become a scene, exports and
 * screenshots. Models are Z-up (CAD and print convention); the scene and glTF are Y-up, so a model
 * is wrapped in a group rotated -90 degrees about X. STL export skips that wrapper and stays Z-up.
 */

export const DEFAULT_PART_COLOR = '#b0b7c3';

/** Faces meeting at less than this stay blended on a smooth part; sharper edges stay crisp. */
const SMOOTH_CREASE = THREE.MathUtils.degToRad(40);

/**
 * Normals are what an engine shades the GLB with (`flatShading` is the viewer's only), so a faceted
 * part gets one normal per face and a smooth one blends the faces that meet under the crease angle.
 */
function shadedGeometry(geometry: THREE.BufferGeometry, smooth: boolean, units: ModelUnits): THREE.BufferGeometry {
  if (!smooth) {
    const faceted = geometry.toNonIndexed();
    faceted.computeVertexNormals();
    return faceted;
  }
  // toCreasedNormals welds positions to 0.01 units: fine in mm, a centimetre in metres, so work in mm.
  const toMm = units === 'm' ? 1000 : 1;
  return toCreasedNormals(geometry.scale(toMm, toMm, toMm), SMOOTH_CREASE).scale(1 / toMm, 1 / toMm, 1 / toMm);
}

/** Part colours are authored as sRGB hex, like every colour picker; three converts them to linear. */
function srgb(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

/**
 * glTF PBR plus the KHR material extensions GLTFExporter writes: clearcoat, sheen, transmission
 * with ior and volume thickness, emissive strength and anisotropy. Unset fields keep three's
 * defaults, so a part that sets none of them exports as plain metallic-roughness. A `texture` adds
 * colour, roughness and bump maps (bump is viewer-only: glTF has no bump map).
 */
export function partMaterial(part: ModelPartMesh, units: ModelUnits = 'mm'): THREE.MeshPhysicalMaterial {
  const color = srgb(part.color || DEFAULT_PART_COLOR);
  const material = new THREE.MeshPhysicalMaterial({
    color,
    flatShading: !part.smooth,
    roughness: part.roughness ?? 0.75,
    metalness: part.metalness ?? 0.05,
  });
  material.name = part.name;
  if (part.clearcoat !== undefined) {
    material.clearcoat = part.clearcoat;
    material.clearcoatRoughness = 0.08;
  }
  if (part.sheen !== undefined && part.sheen > 0) {
    // glTF has no sheen strength, only a colour: the part's own, scaled by `sheen`, is that colour.
    material.sheen = 1;
    material.sheenColor.copy(color).multiplyScalar(part.sheen);
    material.sheenRoughness = 0.6;
  }
  if (part.transmission !== undefined) material.transmission = part.transmission;
  if (part.ior !== undefined) material.ior = part.ior;
  if (part.thickness !== undefined) material.thickness = part.thickness;
  if (part.emissive !== undefined) {
    material.emissive.copy(srgb(part.emissive));
    material.emissiveIntensity = part.emissiveIntensity ?? 1;
  }
  if (part.texture !== undefined) applyTexture(material, part.texture, units);
  // The viewer's pick highlight borrows emissive, then puts these back.
  material.userData.emissive = material.emissive.getHex(THREE.LinearSRGBColorSpace);
  material.userData.emissiveIntensity = material.emissiveIntensity;
  return material;
}

/**
 * The object the viewer, exports and screenshots share. `userData.units` records the model units.
 *
 * Each part is one mesh node with its origin at the part's pivot (its geometry shifted to match)
 * and nested under its parent's node, so the GLB carries a hierarchy an engine can animate.
 * Expects a tree that passed partTreeError.
 */
export function buildModelObject(parts: ModelPartMesh[], units: ModelUnits): THREE.Group {
  const model = new THREE.Group();
  model.name = 'model';
  const origin: [number, number, number] = [0, 0, 0];
  const meshes = parts.map(part => {
    const pivot = part.pivot ?? origin;
    const geometry = new THREE.BufferGeometry();
    // A copy: translate() moves vertices in place, and the parts stay in model space for STL and the summary.
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
    geometry.translate(-pivot[0], -pivot[1], -pivot[2]);
    const material = partMaterial(part, units);
    const shaded = shadedGeometry(geometry, part.smooth === true, units);
    // Only a textured part carries UVs; both shaded forms are non-indexed, as the projection needs.
    if (part.texture !== undefined) boxProjectUvs(shaded, part.texture, units);
    const mesh = new THREE.Mesh(shaded, material);
    mesh.name = part.name;
    return mesh;
  });
  const byName = new Map(parts.map((part, index) => [part.name, { mesh: meshes[index], pivot: part.pivot ?? origin }]));
  // A node's position is relative to its parent, whose own origin sits at the parent's pivot.
  parts.forEach((part, index) => {
    const pivot = part.pivot ?? origin;
    const parent = part.parent === undefined ? undefined : byName.get(part.parent);
    const offset = parent?.pivot ?? origin;
    const mesh = meshes[index];
    mesh.position.set(pivot[0] - offset[0], pivot[1] - offset[1], pivot[2] - offset[2]);
    if (part.axis && part.range) {
      const motion = part.motion ?? 'turn';
      // A slide moves by `step` per range unit from `rest`; both are rewritten by the GLB bake.
      const step = new THREE.Vector3(...part.axis).normalize().toArray();
      const rest = mesh.position.toArray();
      mesh.userData.joint = { motion, axis: part.axis, range: part.range, step, rest } satisfies JointData;
    }
    mesh.userData.home = mesh.position.toArray();
    (parent?.mesh ?? model).add(mesh);
  });
  assignExplodeShifts(parts, meshes);
  model.rotation.x = -Math.PI / 2;
  const root = new THREE.Group();
  root.name = 'root';
  root.userData.units = units;
  root.add(model);
  return root;
}

type Vec3 = [number, number, number];

/** How far Explode moves a part beyond its own offset from its parent, as a share of the model's radius. */
const EXPLODE_CLEARANCE = 0.2;
/** Explode's scale on a part's offset from its parent's centre. */
const EXPLODE_SPREAD = 0.6;

/**
 * Records on each part how far it moves, in its parent's frame, in a fully exploded view: away from
 * its parent's centre (the model's centre for a top-level part), further the further out it sits, so
 * a lid lifts off its box and a lock steps forward off it. A part centred on its parent, such as a
 * band round a box, stays on it. Nothing moves down, so no part sinks through the floor. A
 * child rides along with its parent, so its shift adds to its parent's.
 */
function assignExplodeShifts(parts: ModelPartMesh[], meshes: THREE.Mesh[]): void {
  if (parts.length < 2) return;
  const boxes = parts.map(part => new THREE.Box3().setFromArray(part.positions));
  const centres = boxes.map(box => box.getCenter(new THREE.Vector3()));
  const all = boxes.reduce((union, box) => union.union(box), new THREE.Box3());
  const modelCentre = all.getCenter(new THREE.Vector3());
  const radius = Math.max(all.getBoundingSphere(new THREE.Sphere()).radius, 1e-6);
  const indexByName = new Map(parts.map((part, index) => [part.name, index]));
  parts.forEach((part, index) => {
    const parentIndex = part.parent === undefined ? undefined : indexByName.get(part.parent);
    const from = parentIndex === undefined ? modelCentre : centres[parentIndex];
    const offset = centres[index].clone().sub(from);
    const distance = offset.length();
    // Centred on its parent (a band round a box, a lining): it stays on, since no straight move frees it.
    const shift =
      distance < radius * 0.05
        ? new THREE.Vector3()
        : offset.divideScalar(distance).multiplyScalar(distance * EXPLODE_SPREAD + radius * EXPLODE_CLEARANCE);
    shift.z = Math.max(0, shift.z);
    meshes[index].userData.explode = shift.toArray();
  });
}

type JointData = Omit<ModelJoint, 'name'> & {
  /** Slides only: the node's offset per range unit, in its parent's frame (unit length until baked). */
  step: Vec3;
  /** The node's position in the modelled pose; a slide adds to it, a turn keeps it. */
  rest: Vec3;
};

function jointNodes(root: THREE.Object3D): { node: THREE.Object3D; joint: JointData }[] {
  const found: { node: THREE.Object3D; joint: JointData }[] = [];
  root.traverse(node => {
    const joint = node.userData.joint as JointData | undefined;
    if (joint) found.push({ node, joint });
  });
  return found;
}

function jointRotation(joint: JointData, degrees: number): THREE.Quaternion {
  const axis = new THREE.Vector3(...joint.axis).normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
}

function jointPosition(joint: JointData, amount: number): THREE.Vector3 {
  return new THREE.Vector3(...joint.rest).addScaledVector(new THREE.Vector3(...joint.step), amount);
}

/**
 * Moves each joint to its value: degrees for a turn, model units for a slide (0, the modelled pose,
 * when absent). Joint nodes sit unrotated under unrotated parents, so a node's own rotation about,
 * or offset along, the model-axis direction is the motion the model describes.
 */
export function poseJoints(root: THREE.Object3D, angles: Record<string, number>): void {
  for (const { node, joint } of jointNodes(root)) {
    const amount = angles[node.name] ?? 0;
    if (joint.motion === 'slide') {
      node.userData.slide = amount;
      node.position.copy(jointPosition(joint, amount)).add(explodeShift(node));
    } else node.quaternion.copy(jointRotation(joint, amount));
  }
}

/** The node's current exploded-view shift (zero when the view is assembled). */
function explodeShift(node: THREE.Object3D): THREE.Vector3 {
  const shift = node.userData.explodeShift as Vec3 | undefined;
  return shift ? new THREE.Vector3(...shift) : new THREE.Vector3();
}

/** Whether `root` is a built model whose parts can be pulled apart. */
export function canExplode(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse(node => {
    if (Array.isArray(node.userData.explode)) found = true;
  });
  return found;
}

/**
 * Pulls the parts apart by `amount`: 0 assembled, 1 fully exploded (see assignExplodeShifts). Works
 * with poseJoints in either order: a slide keeps its travel, a turn its angle.
 */
export function explodeModel(root: THREE.Object3D, amount: number): void {
  root.traverse(node => {
    const full = node.userData.explode as Vec3 | undefined;
    const home = node.userData.home as Vec3 | undefined;
    if (!full || !home) return;
    const shift = new THREE.Vector3(...full).multiplyScalar(amount);
    node.userData.explodeShift = shift.toArray();
    const joint = node.userData.joint as JointData | undefined;
    const base =
      joint?.motion === 'slide'
        ? jointPosition(joint, typeof node.userData.slide === 'number' ? node.userData.slide : 0)
        : new THREE.Vector3(...home);
    node.position.copy(base).add(shift);
  });
}

/** Each joint at the far end of its range: what `model_screenshot` shows as the open pose. */
/** The joints the model's nodes carry, as the pane's sliders list them. */
export function sceneJoints(root: THREE.Object3D): ModelJoint[] {
  return jointNodes(root).map(({ node, joint }) => ({
    name: node.name,
    motion: joint.motion,
    axis: joint.axis,
    range: joint.range,
  }));
}

export function openPose(root: THREE.Object3D): Record<string, number> {
  return Object.fromEntries(jointNodes(root).map(({ node, joint }) => [node.name, joint.range[1]]));
}

/**
 * One clip per joint, named after the part, moving it from the first value of its range to the
 * second over a second. A turn keys every 90 degrees at most, since a quaternion track takes the
 * short way; a slide is straight, so its two ends are enough.
 */
function jointClips(root: THREE.Object3D): THREE.AnimationClip[] {
  return jointNodes(root).map(({ node, joint }) => {
    const [from, to] = joint.range;
    if (joint.motion === 'slide') {
      const values = [...jointPosition(joint, from).toArray(), ...jointPosition(joint, to).toArray()];
      return new THREE.AnimationClip(node.name, 1, [
        new THREE.VectorKeyframeTrack(`${node.uuid}.position`, [0, 1], values),
      ]);
    }
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 90));
    const times: number[] = [];
    const values: number[] = [];
    for (let step = 0; step <= steps; step++) {
      times.push(step / steps);
      values.push(...jointRotation(joint, from + ((to - from) * step) / steps).toArray());
    }
    return new THREE.AnimationClip(node.name, 1, [
      new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, values),
    ]);
  });
}

/** Size and triangle count in model axes (x, y, z with z up). */
export function summarizeParts(
  parts: ModelPartMesh[],
  params: Record<string, ModelParam>,
  units: ModelUnits
): ModelSummary {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const part of parts) {
    triangles += part.indices.length / 3;
    for (let index = 0; index < part.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = part.positions[index + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  const size = min.map((low, axis) => (Number.isFinite(low) ? max[axis] - low : 0)) as [number, number, number];
  const joints = describeJoints(parts);
  return {
    parts: parts.map(part => part.name),
    size,
    units,
    triangles,
    params: Object.fromEntries(Object.entries(params).map(([key, param]) => [key, param.value])),
    ...(joints.length ? { joints } : {}),
  };
}

/** Binary STL of every part, in model units and Z-up, as slicers expect. */
export function partsToStl(parts: ModelPartMesh[]): Uint8Array {
  const triangles = parts.reduce((total, part) => total + part.indices.length / 3, 0);
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  let offset = 84;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const part of parts) {
    const { positions, indices } = part;
    for (let index = 0; index < indices.length; index += 3) {
      a.fromArray(positions, indices[index] * 3);
      b.fromArray(positions, indices[index + 1] * 3);
      c.fromArray(positions, indices[index + 2] * 3);
      normal.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
      for (const vector of [normal, a, b, c]) {
        view.setFloat32(offset, vector.x, true);
        view.setFloat32(offset + 4, vector.y, true);
        view.setFloat32(offset + 8, vector.z, true);
        offset += 12;
      }
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** The bake leaves scales a rounding error off 1 (0.9999999999999999); an engine would show that as a scaled node. */
function snapUnitScale(scale: THREE.Vector3): void {
  for (const axis of ['x', 'y', 'z'] as const) if (Math.abs(scale[axis] - 1) < 1e-9) scale[axis] = 1;
}

/**
 * Moves the unit scale and axis turn held by the root and its direct children into the geometry and
 * node positions below them, so every node in the file is in metres, Y-up and unscaled: what an
 * engine shows as an asset's transform. A node's local matrix L becomes M L M^-1 and its vertices
 * M v, which leaves every world position where it was.
 */
function bakeTopTransforms(root: THREE.Object3D): void {
  root.updateMatrix();
  for (const top of root.children) {
    top.updateMatrix();
    const bake = root.matrix.clone().multiply(top.matrix);
    const unbake = bake.clone().invert();
    top.traverse(node => {
      if (node instanceof THREE.Mesh)
        node.geometry = (node.geometry as THREE.BufferGeometry).clone().applyMatrix4(bake);
      if (node === top) return;
      const joint = node.userData.joint as JointData | undefined;
      node.updateMatrix();
      bake.clone().multiply(node.matrix).multiply(unbake).decompose(node.position, node.quaternion, node.scale);
      snapUnitScale(node.scale);
      if (joint) {
        // The bake turns node frames by M, so a turn about a becomes a turn about M a, and a slide's
        // step (a parent-frame offset) picks up M's turn and its unit scale.
        const axis = new THREE.Vector3(...joint.axis).transformDirection(bake);
        const step = new THREE.Vector3(...joint.step).applyMatrix3(new THREE.Matrix3().setFromMatrix4(bake));
        // Exports pose every joint at rest before the bake, so the baked position is the rest one.
        node.userData.joint = {
          ...joint,
          axis: axis.toArray(),
          step: step.toArray(),
          rest: node.position.toArray(),
        } satisfies JointData;
      }
    });
    top.position.set(0, 0, 0);
    top.quaternion.identity();
    top.scale.set(1, 1, 1);
  }
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
}

/**
 * KHR_materials_volume measures thickness in the mesh's own units, which the bake turns into
 * metres. Materials are shared with the viewer's object by clone(), so each is copied first.
 */
function scaleThickness(root: THREE.Object3D, factor: number): void {
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh) || !(node.material instanceof THREE.MeshPhysicalMaterial)) return;
    if (node.material.thickness === 0) return;
    const material = node.material.clone();
    material.thickness *= factor;
    node.material = material;
  });
}

/**
 * GLTFExporter merges a separate roughness and metalness map with canvas drawImage, which cannot
 * draw a DataTexture's raw pixels, so a textured part failed to export. The procedural roughness
 * maps are already packed the glTF way (roughness in G, B at full so the metalness factor applies
 * as is; see textureBytes in proceduralTextures.ts), so the exporter gets that one map for both and
 * writes it unchanged. Materials are shared with the viewer's object by clone(), so each is copied.
 */
export function shareMetalRoughMaps(root: THREE.Object3D): void {
  root.traverse(node => {
    if (!(node instanceof THREE.Mesh) || !(node.material instanceof THREE.MeshStandardMaterial)) return;
    const { roughnessMap, metalnessMap } = node.material;
    if (!(roughnessMap instanceof THREE.DataTexture) || metalnessMap) return;
    const material = node.material.clone();
    material.metalnessMap = roughnessMap;
    node.material = material;
  });
}

/**
 * GLB in metres and Y-up (glTF's convention), one node and material per part, pivots kept. Always
 * in the modelled pose, whatever the pane's joint sliders show, plus one animation clip per joint.
 */
export async function exportGlb(root: THREE.Object3D): Promise<Uint8Array> {
  const scene = new THREE.Scene();
  const copy = root.clone(true);
  poseJoints(copy, {});
  if (copy.userData.units === 'mm') {
    copy.scale.setScalar(0.001);
    scaleThickness(copy, 0.001);
  }
  shareMetalRoughMaps(copy);
  bakeTopTransforms(copy);
  scene.add(copy);
  // TRS rather than a matrix: glTF forbids `matrix` on a node an animation targets, and these
  // nodes exist so an engine can animate them.
  const result = await new GLTFExporter().parseAsync(scene, { binary: true, trs: true, animations: jointClips(copy) });
  if (!(result instanceof ArrayBuffer)) throw new Error('The GLB exporter returned JSON instead of binary.');
  return new Uint8Array(result);
}

/** A viewable object from an existing asset. glTF is metres; STL carries no unit and is assumed mm, Z-up. */
export async function loadAsset(kind: Exclude<ModelKind, 'model'>, bytes: Uint8Array): Promise<THREE.Group> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const root = new THREE.Group();
  root.name = 'root';
  if (kind === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshPhysicalMaterial({ color: srgb(DEFAULT_PART_COLOR), flatShading: true, roughness: 0.75 })
    );
    const model = new THREE.Group();
    model.rotation.x = -Math.PI / 2;
    model.add(mesh);
    root.add(model);
    root.userData.units = 'mm';
    return root;
  }
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  root.add(gltf.scene);
  // Kept on the root (Object3D.clone copies `animations`), so the viewer's copy can play them.
  root.animations = gltf.animations;
  root.userData.units = 'm';
  return root;
}

/** Summary for a loaded asset, from its world bounding box, reported in model axes (z up). */
export function summarizeObject(root: THREE.Object3D): ModelSummary {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  let triangles = 0;
  const parts: string[] = [];
  root.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const geometry = child.geometry as THREE.BufferGeometry;
      triangles += (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
      parts.push(child.name || `part${parts.length + 1}`);
    }
  });
  return { parts, size: [size.x, size.z, size.y], units: String(root.userData.units ?? 'mm'), triangles, params: {} };
}

/** Camera directions in scene (Y-up) space; "front" looks at the model's -Y face, which faces +Z here. */
export const VIEW_DIRECTIONS: Record<ModelView, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0001],
  iso: [1, 0.8, 1],
};

/** Half the narrower of the camera's two fields of view (radians): what decides how much fits. */
export function fitAngle(camera: THREE.PerspectiveCamera): number {
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  return Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
}

export function frameCamera(
  camera: THREE.PerspectiveCamera,
  root: THREE.Object3D,
  direction: [number, number, number] = VIEW_DIRECTIONS.iso
): THREE.Vector3 {
  root.updateMatrixWorld(true);
  return frameBox(camera, new THREE.Box3().setFromObject(root), direction);
}

/** How close to the view's edge, as a share of its half-width, a model may reach before it counts as cropped. */
export const VIEW_EDGE_MARGIN = 0.02;

/**
 * Whether some corner of `box` lies past the camera's view, or within `margin` of its edge, or behind
 * it: a rebuild that grew the model out of frame. Reads the camera's current matrices.
 */
export function extendsPastView(camera: THREE.PerspectiveCamera, box: THREE.Box3, margin = VIEW_EDGE_MARGIN): boolean {
  if (box.isEmpty()) return false;
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const limit = 1 - margin;
  const corner = new THREE.Vector3();
  for (let index = 0; index < 8; index += 1) {
    corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z);
    corner.applyMatrix4(camera.matrixWorldInverse);
    if (corner.z > -camera.near) return true;
    corner.applyMatrix4(camera.projectionMatrix);
    if (Math.abs(corner.x) > limit || Math.abs(corner.y) > limit) return true;
  }
  return false;
}

/** frameCamera for a box rather than a whole object: what a close-up of some parts frames. */
export function frameBox(
  camera: THREE.PerspectiveCamera,
  box: THREE.Box3,
  direction: [number, number, number] = VIEW_DIRECTIONS.iso
): THREE.Vector3 {
  const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  // The narrower of the two fields of view decides, or a tall pane crops the model's sides.
  const distance = (radius / Math.sin(fitAngle(camera))) * 1.1;
  const offset = new THREE.Vector3(...direction).normalize().multiplyScalar(distance);
  camera.position.copy(sphere.center).add(offset);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  return sphere.center.clone();
}

const TILE = 512;

/** Each tile renders at twice its size and is drawn down, which smooths edges the AO pass leaves. */
const TILE_SUPERSAMPLE = 2;

/**
 * One labelled tile per view, laid out in a grid, as a PNG. Rendered off screen with a renderer of
 * its own, so it works whether or not the pane is visible, and through the pane's stage and
 * composer (modelStage.ts), so the agent sees the lighting, shadows and AO the user does.
 * Joints are posed at `angles` (degrees by part name; the modelled pose when absent), not as the
 * pane shows them.
 */
export async function renderContactSheet(
  root: THREE.Object3D,
  views: ModelView[],
  dark: boolean,
  angles: Record<string, number> = {}
): Promise<Uint8Array> {
  const columns = views.length <= 2 ? views.length : views.length <= 4 ? 2 : 3;
  const rows = Math.ceil(views.length / columns);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const stage = new ModelStage(scene, renderer);
  const composer = new ModelComposer(renderer, scene, camera);
  try {
    renderer.setPixelRatio(TILE_SUPERSAMPLE);
    renderer.setSize(TILE, TILE, false);
    composer.setSize(TILE, TILE, TILE_SUPERSAMPLE);
    const subject = root.clone(true);
    poseJoints(subject, angles);
    enableShadows(subject);
    scene.add(subject);
    // Fitted to the pose shown, so an open lid's shadow stays inside the shadow camera.
    stage.fit(subject, { dark, grid: false });
    composer.fit(stage.bounds);
    const sheet = document.createElement('canvas');
    sheet.width = columns * TILE;
    sheet.height = rows * TILE;
    const context = sheet.getContext('2d');
    if (!context) throw new Error('No 2D canvas available for the screenshot.');
    context.imageSmoothingQuality = 'high';
    views.forEach((view, index) => {
      frameCamera(camera, subject, VIEW_DIRECTIONS[view]);
      composer.render();
      const x = (index % columns) * TILE;
      const y = Math.floor(index / columns) * TILE;
      context.drawImage(renderer.domElement, x, y, TILE, TILE);
      context.font = 'bold 22px sans-serif';
      context.fillStyle = dark ? '#e6e8eb' : '#22262b';
      context.fillText(view.toUpperCase(), x + 14, y + 32);
      context.strokeStyle = dark ? '#3a4048' : '#d5d8dd';
      context.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    });
    const blob = await new Promise<Blob | null>(resolve => sheet.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The screenshot could not be encoded.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    composer.dispose();
    stage.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

/** How faint the parts around a close-up's subject are drawn. */
const CLOSEUP_CONTEXT_OPACITY = 0.14;

/** The world-space bounds of the meshes named `names` under `root`; empty when none match. */
export function partsBox(root: THREE.Object3D, names: readonly string[]): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse(child => {
    if (child instanceof THREE.Mesh && names.includes(child.name)) box.expandByObject(child);
  });
  return box;
}

/**
 * A single 3/4 view framed on the parts named `names`, with every other part drawn faint for
 * context, as a PNG: what a point-and-edit turn attaches so the agent sees exactly what was picked.
 * Rendered off screen like renderContactSheet, through the same stage and composer.
 */
export async function renderPartCloseup(
  root: THREE.Object3D,
  names: readonly string[],
  dark: boolean,
  angles: Record<string, number> = {}
): Promise<Uint8Array> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const stage = new ModelStage(scene, renderer);
  const composer = new ModelComposer(renderer, scene, camera);
  const faded: THREE.Material[] = [];
  try {
    renderer.setPixelRatio(TILE_SUPERSAMPLE);
    renderer.setSize(TILE, TILE, false);
    composer.setSize(TILE, TILE, TILE_SUPERSAMPLE);
    const subject = root.clone(true);
    poseJoints(subject, angles);
    enableShadows(subject);
    subject.traverse(child => {
      if (!(child instanceof THREE.Mesh) || names.includes(child.name)) return;
      // Cloned: the clone shares materials with the live view, which must not fade.
      const material = (child.material as THREE.Material).clone();
      material.transparent = true;
      material.opacity = CLOSEUP_CONTEXT_OPACITY;
      material.depthWrite = false;
      child.material = material;
      child.castShadow = false;
      faded.push(material);
    });
    scene.add(subject);
    stage.fit(subject, { dark, grid: false });
    composer.fit(stage.bounds);
    const box = partsBox(subject, names);
    if (box.isEmpty()) box.setFromObject(subject);
    frameBox(camera, box, VIEW_DIRECTIONS.iso);
    composer.render();
    const blob = await new Promise<Blob | null>(resolve => renderer.domElement.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The close-up could not be encoded.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    for (const material of faded) material.dispose();
    composer.dispose();
    stage.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
