import * as THREE from 'three';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The studio the model pane and the `model_screenshot` contact sheet both render in, so the agent
 * judges what the user sees: filmic tone mapping, a procedural softbox environment, a key light
 * casting soft shadows onto a shadow-catcher floor, and ambient occlusion as a post pass.
 * Everything is fitted to the model's bounds, since models come in mm or m. A night lighting mode
 * dims the studio to moonlight so emissive parts carry the scene: they bloom and light what is near.
 */

export const TONE_MAPPING_EXPOSURE = 1;

// three's ACESFilmicToneMapping (tonemapping_pars_fragment), row-major here; must stay in step with it.
const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

const multiply = (matrix: number[][], vector: number[]): number[] =>
  matrix.map(row => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);

const rrtAndOdtFit = (value: number): number =>
  (value * (value + 0.0245786) - 0.000090537) / (value * (0.983729 * value + 0.432951) + 0.238081);

/** What the output pass makes of a linear colour: ACES at the pane's exposure, clamped, still linear. */
export function toneMapped(linear: THREE.Color): THREE.Color {
  const exposed = [linear.r, linear.g, linear.b].map(value => (value * TONE_MAPPING_EXPOSURE) / 0.6);
  const [r, g, b] = multiply(ACES_OUTPUT, multiply(ACES_INPUT, exposed).map(rrtAndOdtFit)).map(value =>
    THREE.MathUtils.clamp(value, 0, 1)
  );
  return new THREE.Color(r, g, b);
}

/**
 * The linear colour that comes out of the tone mapping as `hex`: the backdrop goes through the
 * output pass with the model, and should still match the pane's chrome. Each channel is monotonic
 * in its own input, so it is bisected with the others held; a few rounds settle the small
 * cross-talk the ACES matrices add between channels.
 */
export function untoneMapped(hex: string): THREE.Color {
  const target = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
  const guess = target.clone();
  const channels = ['r', 'g', 'b'] as const;
  for (let round = 0; round < 4; round += 1) {
    for (const channel of channels) {
      let low = 0;
      let high = 64;
      for (let step = 0; step < 40; step += 1) {
        guess[channel] = (low + high) / 2;
        if (toneMapped(guess)[channel] < target[channel]) low = guess[channel];
        else high = guess[channel];
      }
    }
  }
  return guess;
}

/** The pane's backdrop colours from before tone mapping, pre-compensated so they still show as is. */
// Night is black: the glow light's shadow blackens the floor, whose edge would show on anything lighter.
const BACKDROP = { light: untoneMapped('#f4f5f7'), dark: untoneMapped('#1b1e23'), night: new THREE.Color(0, 0, 0) };

export type StageLighting = 'studio' | 'night';

/** Per lighting mode: how much of the softbox studio is left, and the key light's colour and strength. */
const LIGHTING: Record<StageLighting, { environment: number; key: number; keyColor: number }> = {
  studio: { environment: 1, key: 3, keyColor: 0xffffff },
  night: { environment: 0.1, key: 1, keyColor: 0x9fb4ff },
};

/** The most glow lights a model gets; each is a point light every lit fragment pays for. */
export const MAX_GLOW_LIGHTS = 4;

/** A mesh's own glow as partMaterial recorded it, or null when it does not glow. */
function glowOf(mesh: THREE.Mesh): { color: THREE.Color; strength: number } | null {
  const material = mesh.material as THREE.Material;
  const hex = material.userData.emissive;
  const intensity = material.userData.emissiveIntensity;
  if (typeof hex !== 'number' || hex === 0) return null;
  const color = new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
  const strength = ((color.r + color.g + color.b) / 3) * (typeof intensity === 'number' ? intensity : 1);
  return strength > 0 ? { color, strength } : null;
}

/**
 * Night mode: a point light at the heart of each of the brightest glowing parts, as a child of the
 * part so it follows a lid as it opens. Sized to the model (`radius`, in model units); the brightest
 * casts shadows, so a closed lid keeps its light inside; the glowing parts themselves stop casting,
 * or each would wrap its own light in shadow. Returns the lights added.
 */
export function addGlowLights(object: THREE.Object3D, radius: number): THREE.PointLight[] {
  const glowing: { mesh: THREE.Mesh; color: THREE.Color; strength: number }[] = [];
  object.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const glow = glowOf(node);
    if (glow) glowing.push({ mesh: node, ...glow });
  });
  glowing.sort((a, b) => b.strength - a.strength);
  return glowing.slice(0, MAX_GLOW_LIGHTS).map(({ mesh, color, strength }, index) => {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    const centre = geometry.boundingBox ? geometry.boundingBox.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    // Physical falloff (decay 2) in model units: scale by radius squared so mm and m models match.
    const light = new THREE.PointLight(color, strength * radius * radius * 1.6, radius * 4, 2);
    light.position.copy(centre);
    light.name = 'glow';
    if (index === 0) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.near = radius * 0.01;
      light.shadow.camera.far = radius * 4;
      // Shadow maps hold back faces, so a lip just outside a wall sits at the wall's own depth; a
      // positive bias (in depth over `far`, about a model unit here) keeps it dark.
      light.shadow.bias = 0.0012;
      light.shadow.radius = 1;
    }
    mesh.castShadow = false;
    mesh.add(light);
    return light;
  });
}

/** The softboxes' direction from the model; the shadow-casting key light comes from the brightest. */
const KEY_DIRECTION = new THREE.Vector3(-0.6, 1, 0.45).normalize();

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES over AgX: side by side on the same models, AgX left wood and brass washed out.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
  renderer.shadowMap.enabled = true;
  // PCF in r18x filters with `shadow.radius` (PCFSoftShadowMap is gone), which is what softens it.
  renderer.shadowMap.type = THREE.PCFShadowMap;
}

function softbox(width: number, height: number, intensity: number): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(intensity) });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
}

/**
 * A photo studio as an environment: a grey cyclorama that is lighter overhead, a large key softbox
 * matching the shadow light, a fill strip opposite and a rim strip behind. Procedural, so the app
 * ships no HDRI file (the renderer CSP forbids fetching one) and carries no asset licence.
 */
function studioScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const dome = new THREE.SphereGeometry(10, 32, 16);
  const colors: number[] = [];
  const position = dome.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const height = position.getY(index) / 10;
    // Dark floor, mid-grey walls, a brighter ceiling: what a matte metal part reflects at each angle.
    const value = height < 0 ? THREE.MathUtils.lerp(0.18, 0.06, -height) : THREE.MathUtils.lerp(0.3, 0.55, height);
    colors.push(value, value, value);
  }
  dome.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  const place = (mesh: THREE.Mesh, direction: THREE.Vector3, distance: number) => {
    mesh.position.copy(direction).normalize().multiplyScalar(distance);
    mesh.lookAt(0, 0, 0);
    scene.add(mesh);
  };
  place(softbox(6, 4, 9), KEY_DIRECTION, 6);
  place(softbox(3, 6, 4), new THREE.Vector3(1, 0.3, 0.5), 6);
  place(softbox(5, 1, 5), new THREE.Vector3(0.2, 0.6, -1), 6);
  place(softbox(4, 4, 2.5), new THREE.Vector3(0, 1, 0), 6);
  return scene;
}

function disposeScene(scene: THREE.Scene): void {
  scene.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    (node.geometry as THREE.BufferGeometry).dispose();
    (node.material as THREE.Material).dispose();
  });
}

/** Every mesh casts and receives, so a lid shades the box under it as well as the floor. */
export function enableShadows(object: THREE.Object3D): void {
  object.traverse(node => {
    if (node instanceof THREE.Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
}

function gridFor(box: THREE.Box3, dark: boolean): THREE.GridHelper {
  const size = box.isEmpty() ? 1 : Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  // A grid a few times the footprint, rounded up to a power of ten per cell, so its squares read as units.
  const cell = 10 ** Math.floor(Math.log10(Math.max(size, 1e-3) / 2));
  const extent = Math.ceil((size * 3) / cell) * cell;
  const grid = new THREE.GridHelper(
    extent,
    Math.round(extent / cell),
    dark ? 0x59606b : 0x7d838c,
    dark ? 0x353a42 : 0xa9afb8
  );
  // Faded and drawn under the model, so it reads as a measure rather than as the floor.
  for (const material of [grid.material].flat()) {
    material.transparent = true;
    material.opacity = 0.6;
    material.depthWrite = false;
  }
  grid.name = 'grid';
  return grid;
}

export type StageOptions = { dark: boolean; grid: boolean; lighting?: StageLighting };

/**
 * The studio around one model: environment, key light, shadow-catcher floor and optional grid,
 * all in a group of its own so the caller's content stays apart. `fit` re-sizes it to a model.
 */
export class ModelStage {
  readonly environment: THREE.Texture;
  private readonly group = new THREE.Group();
  private readonly key = new THREE.DirectionalLight(0xffffff, 3);
  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
  private grid: THREE.GridHelper | null = null;
  readonly bounds = new THREE.Box3();

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer
  ) {
    configureRenderer(renderer);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const studio = studioScene();
    this.environment = pmrem.fromScene(studio, 0.02).texture;
    disposeScene(studio);
    pmrem.dispose();
    scene.environment = this.environment;
    scene.environmentIntensity = 1;

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.blurSamples = 16;
    this.group.add(this.key, this.key.target);

    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.3 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.name = 'floor';
    this.group.add(this.floor);
    this.group.name = 'stage';
    scene.add(this.group);
  }

  /** Sizes the light, its shadow camera and the floor to `object` (null keeps a unit-sized stage). */
  fit(object: THREE.Object3D | null, { dark, grid, lighting = 'studio' }: StageOptions): void {
    const night = lighting === 'night';
    const mode = LIGHTING[lighting];
    this.scene.background = night ? BACKDROP.night : dark ? BACKDROP.dark : BACKDROP.light;
    this.scene.environmentIntensity = mode.environment;
    this.key.intensity = mode.key;
    this.key.color.setHex(mode.keyColor);
    this.bounds.makeEmpty();
    if (object) {
      object.updateMatrixWorld(true);
      this.bounds.setFromObject(object);
    }
    const box = this.bounds.isEmpty()
      ? new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5))
      : this.bounds;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1e-3);
    const floorY = box.min.y;

    this.key.target.position.copy(sphere.center);
    this.key.position.copy(sphere.center).addScaledVector(KEY_DIRECTION, radius * 4);
    const camera = this.key.shadow.camera;
    // Wide enough for the shadow the key light throws across the floor, tight enough to stay sharp.
    const reach = radius * 1.6;
    camera.left = -reach;
    camera.right = reach;
    camera.top = reach;
    camera.bottom = -reach;
    camera.near = radius * 0.5;
    camera.far = radius * 8;
    camera.updateProjectionMatrix();
    // In model units, so a mm model and a m model get the same acne-free shadow.
    this.key.shadow.normalBias = radius * 0.004;
    this.key.shadow.bias = -0.0002;
    this.key.shadow.needsUpdate = true;

    this.floor.position.set(sphere.center.x, floorY, sphere.center.z);
    this.floor.scale.setScalar(radius * 12);
    this.floor.material.opacity = night ? 0.7 : dark ? 0.5 : 0.55;

    if (this.grid) {
      this.group.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
    }
    if (grid) {
      this.grid = gridFor(box, dark || night);
      this.grid.position.set(sphere.center.x, floorY, sphere.center.z);
      this.group.add(this.grid);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.grid?.dispose();
    this.floor.geometry.dispose();
    this.floor.material.dispose();
    this.key.dispose();
    this.environment.dispose();
  }

  /** The fitted model's bounding-sphere radius, in model units (1 for an empty stage). */
  get radius(): number {
    return this.bounds.isEmpty() ? 1 : Math.max(this.bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
  }
}

/** Blur, as a share of the frame, at one model radius in front of or behind the focus. */
const DOF_BLUR = 0.006;
/** The most any point blurs, as a share of the frame: the backdrop, far behind, stops here. */
const DOF_MAX_BLUR = 0.008;

/**
 * Render, then GTAO so creases and lid gaps read, then tone mapping and sRGB in the output pass.
 * `render(false)` skips the AO for frames drawn while the user orbits or a clip plays. Bloom runs
 * on the linear HDR image before tone mapping, and only in night mode: the studio backdrop is
 * brighter than white (see `untoneMapped`), so any threshold low enough for a glow would bloom it.
 * A recording adds a depth of field after the bloom (setFocus).
 */
export class ModelComposer {
  private readonly composer: EffectComposer;
  private readonly ambientOcclusion: GTAOPass;
  private readonly output = new OutputPass();
  private readonly bloom: UnrealBloomPass;
  private readonly depthOfField: BokehPass;
  /** The fitted model's bounding radius, which the depth of field's blur is scaled by. */
  private radius = 1;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Multisampled, since rendering into a target bypasses the canvas's own antialiasing.
    const target = new THREE.WebGLRenderTarget(Math.max(size.x, 1), Math.max(size.y, 1), {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ambientOcclusion = new GTAOPass(scene, camera, Math.max(size.x, 1), Math.max(size.y, 1));
    this.ambientOcclusion.blendIntensity = 0.85;
    this.composer.addPass(this.ambientOcclusion);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(size.x, 1), Math.max(size.y, 1)), 0.7, 0.35, 1.2);
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.depthOfField = new BokehPass(scene, camera, { focus: 1, aperture: 0, maxblur: DOF_MAX_BLUR });
    this.depthOfField.enabled = false;
    this.composer.addPass(this.depthOfField);
    this.composer.addPass(this.output);
  }

  /** Scales the AO to the model: its sample radius is in world units, so mm and m models differ by 1000. */
  fit(bounds: THREE.Box3): void {
    if (bounds.isEmpty()) return;
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    this.radius = Math.max(radius, 1e-6);
    this.ambientOcclusion.updateGtaoMaterial({
      radius: radius * 0.3,
      thickness: radius * 0.3,
      distanceFallOff: 1,
      scale: 1.6,
    });
    this.ambientOcclusion.setSceneClipBox(bounds.clone().expandByScalar(radius * 0.25));
  }

  /**
   * Focuses a shallow depth of field `distance` (world units) from the camera, as a macro lens
   * would on a small object, or turns it off (null). The blur is scaled to the fitted model, so
   * its far side softens the same for a mm or an m model.
   */
  setFocus(distance: number | null): void {
    this.depthOfField.enabled = distance !== null;
    if (distance === null) return;
    this.depthOfField.materialBokeh.uniforms.focus.value = distance;
    this.depthOfField.materialBokeh.uniforms.aperture.value = DOF_BLUR / this.radius;
  }

  setLighting(lighting: StageLighting): void {
    this.bloom.enabled = lighting === 'night';
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(withAmbientOcclusion = true): void {
    this.ambientOcclusion.enabled = withAmbientOcclusion;
    this.composer.render();
  }

  dispose(): void {
    this.ambientOcclusion.dispose();
    this.bloom.dispose();
    this.depthOfField.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
