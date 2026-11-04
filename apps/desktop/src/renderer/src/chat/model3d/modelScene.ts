import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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

/**
 * three.js side of the model pane: meshes from the sandboxed engine become a scene, exports and
 * screenshots. Models are Z-up (CAD and print convention); the scene and glTF are Y-up, so a model
 * is wrapped in a group rotated -90 degrees about X. STL export skips that wrapper and stays Z-up.
 */

export const DEFAULT_PART_COLOR = '#b0b7c3';

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
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(part.color || DEFAULT_PART_COLOR),
      flatShading: true,
      roughness: 0.75,
      metalness: 0.05,
    });
    material.name = part.name;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = part.name;
    if (part.axis && part.range) mesh.userData.joint = { axis: part.axis, range: part.range } satisfies JointData;
    return mesh;
  });
  const byName = new Map(parts.map((part, index) => [part.name, { mesh: meshes[index], pivot: part.pivot ?? origin }]));
  // A node's position is relative to its parent, whose own origin sits at the parent's pivot.
  parts.forEach((part, index) => {
    const pivot = part.pivot ?? origin;
    const parent = part.parent === undefined ? undefined : byName.get(part.parent);
    const offset = parent?.pivot ?? origin;
    meshes[index].position.set(pivot[0] - offset[0], pivot[1] - offset[1], pivot[2] - offset[2]);
    (parent?.mesh ?? model).add(meshes[index]);
  });
  model.rotation.x = -Math.PI / 2;
  const root = new THREE.Group();
  root.name = 'root';
  root.userData.units = units;
  root.add(model);
  return root;
}

type JointData = Omit<ModelJoint, 'name'>;

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

/**
 * Turns each joint to its angle in degrees (0, the modelled pose, when absent). Joint nodes sit
 * unrotated under unrotated parents, so a node's own rotation about the model-axis direction is
 * the turn the model describes.
 */
export function poseJoints(root: THREE.Object3D, angles: Record<string, number>): void {
  for (const { node, joint } of jointNodes(root)) node.quaternion.copy(jointRotation(joint, angles[node.name] ?? 0));
}

/** Each joint at the far end of its range: what `model_screenshot` shows as the open pose. */
export function openPose(root: THREE.Object3D): Record<string, number> {
  return Object.fromEntries(jointNodes(root).map(({ node, joint }) => [node.name, joint.range[1]]));
}

/**
 * One clip per joint, named after the part, turning it from the first angle of its range to the
 * second over a second. Keys every 90 degrees at most, since a quaternion track takes the short way.
 */
function jointClips(root: THREE.Object3D): THREE.AnimationClip[] {
  return jointNodes(root).map(({ node, joint }) => {
    const [from, to] = joint.range;
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
      if (joint) {
        // The bake turns node frames by M, so a turn about a becomes a turn about M a.
        const axis = new THREE.Vector3(...joint.axis).transformDirection(bake);
        node.userData.joint = { ...joint, axis: axis.toArray() } satisfies JointData;
      }
      node.updateMatrix();
      bake.clone().multiply(node.matrix).multiply(unbake).decompose(node.position, node.quaternion, node.scale);
      snapUnitScale(node.scale);
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
 * GLB in metres and Y-up (glTF's convention), one node and material per part, pivots kept. Always
 * in the modelled pose, whatever the pane's joint sliders show, plus one animation clip per joint.
 */
export async function exportGlb(root: THREE.Object3D): Promise<Uint8Array> {
  const scene = new THREE.Scene();
  const copy = root.clone(true);
  poseJoints(copy, {});
  if (copy.userData.units === 'mm') copy.scale.setScalar(0.001);
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
      new THREE.MeshStandardMaterial({ color: DEFAULT_PART_COLOR, flatShading: true, roughness: 0.75 })
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
const VIEW_DIRECTIONS: Record<ModelView, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.0001],
  iso: [1, 0.8, 1],
};

export function frameCamera(
  camera: THREE.PerspectiveCamera,
  root: THREE.Object3D,
  direction: [number, number, number] = VIEW_DIRECTIONS.iso
): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const sphere = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-3);
  // The narrower of the two fields of view decides, or a tall pane crops the model's sides.
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.1;
  const offset = new THREE.Vector3(...direction).normalize().multiplyScalar(distance);
  camera.position.copy(sphere.center).add(offset);
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  return sphere.center.clone();
}

export function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
}

const TILE = 512;

/**
 * One labelled tile per view, laid out in a grid, as a PNG. Rendered off screen with a renderer of
 * its own, so it works whether or not the pane is visible.
 */
/** Joints are posed at `angles` (degrees by part name; the modelled pose when absent), not as the pane shows them. */
export async function renderContactSheet(
  root: THREE.Object3D,
  views: ModelView[],
  dark: boolean,
  angles: Record<string, number> = {}
): Promise<Uint8Array> {
  const columns = views.length <= 2 ? views.length : views.length <= 4 ? 2 : 3;
  const rows = Math.ceil(views.length / columns);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(TILE, TILE, false);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(dark ? '#1f2329' : '#f4f5f7');
    addLights(scene);
    const subject = root.clone(true);
    poseJoints(subject, angles);
    scene.add(subject);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const sheet = document.createElement('canvas');
    sheet.width = columns * TILE;
    sheet.height = rows * TILE;
    const context = sheet.getContext('2d');
    if (!context) throw new Error('No 2D canvas available for the screenshot.');
    views.forEach((view, index) => {
      frameCamera(camera, subject, VIEW_DIRECTIONS[view]);
      renderer.render(scene, camera);
      const x = (index % columns) * TILE;
      const y = Math.floor(index / columns) * TILE;
      context.drawImage(renderer.domElement, x, y);
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
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
