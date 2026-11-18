import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { enableShadows, ModelStage, viewportPixelRatio } from './modelStage';
import { frameBox, poseJoints, VIEW_DIRECTIONS } from './modelScene';

export type CompareSubject = { object: THREE.Object3D; angles: Record<string, number> };

/** The overlay's ghost: the compared-with version, drawn see-through in the accent so both read at once. */
const GHOST_COLOR = new THREE.Color('#2f7cf6');
const GHOST_OPACITY = 0.32;

/** A posed copy of `subject`; the clone shares geometry and materials with the pane's own build. */
function posedCopy({ object, angles }: CompareSubject): THREE.Object3D {
  const copy = object.clone(true);
  poseJoints(copy, angles);
  copy.updateMatrixWorld(true);
  return copy;
}

/** Repaints `root` as a see-through ghost; returns the materials it made, for disposal. */
export function ghostify(root: THREE.Object3D): THREE.Material[] {
  const made: THREE.Material[] = [];
  root.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const material = new THREE.MeshBasicMaterial({
      color: GHOST_COLOR,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
    });
    child.material = material;
    child.castShadow = false;
    child.receiveShadow = false;
    child.renderOrder = 1;
    made.push(material);
  });
  return made;
}

/**
 * Two versions of a model in one view the user can orbit: side by side (two scenes drawn into the
 * left and right halves through one shared camera, so they turn together) or overlaid (one scene,
 * `first` solid and `second` as a ghost). Lit by the pane's stage (modelStage.ts) without the AO
 * pass, since nothing here animates and a compare is about shape, not finish.
 */
export class VersionCompareView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly scenes: { scene: THREE.Scene; stage: ModelStage }[] = [];
  private readonly made: THREE.Material[] = [];
  private readonly observer: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    first: CompareSubject,
    second: CompareSubject,
    private readonly mode: 'side' | 'overlay',
    dark: boolean
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(viewportPixelRatio(window.devicePixelRatio));
    this.renderer.setScissorTest(mode === 'side');
    this.renderer.domElement.dataset.testid = 'model-version-compare-canvas';
    host.appendChild(this.renderer.domElement);

    const a = posedCopy(first);
    const b = posedCopy(second);
    const bounds = new THREE.Box3().setFromObject(a).union(new THREE.Box3().setFromObject(b));
    if (mode === 'overlay') {
      this.made.push(...ghostify(b));
      enableShadows(a);
      this.addScene([a, b], a, dark);
    } else {
      enableShadows(a);
      enableShadows(b);
      this.addScene([a], a, dark);
      this.addScene([b], b, dark);
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());
    this.observer = new ResizeObserver(() => this.resize(bounds));
    this.observer.observe(host);
    this.resize(bounds);
  }

  private addScene(objects: THREE.Object3D[], fitTo: THREE.Object3D, dark: boolean): void {
    const scene = new THREE.Scene();
    const stage = new ModelStage(scene, this.renderer);
    scene.add(...objects);
    stage.fit(fitTo, { dark, grid: true });
    this.scenes.push({ scene, stage });
  }

  private resize(bounds: THREE.Box3): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = (this.mode === 'side' ? width / 2 : width) / height;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(frameBox(this.camera, bounds, VIEW_DIRECTIONS.iso));
    this.controls.update();
    this.render();
  }

  render(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    if (this.mode === 'overlay') {
      this.renderer.render(this.scenes[0].scene, this.camera);
      return;
    }
    const half = Math.floor(width / 2);
    this.scenes.forEach(({ scene }, index) => {
      const x = index * half;
      this.renderer.setViewport(x, 0, half, height);
      this.renderer.setScissor(x, 0, half, height);
      this.renderer.render(scene, this.camera);
    });
  }

  dispose(): void {
    this.observer.disconnect();
    this.controls.dispose();
    for (const { stage } of this.scenes) stage.dispose();
    for (const material of this.made) material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
