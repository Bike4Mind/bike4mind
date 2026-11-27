import * as THREE from 'three';
import { sectionPlane, setClipPlane, type SectionState } from './section';

const CAP_COLOR = new THREE.Color('#d0603f');

function stencilMaterial(side: THREE.Side, operation: THREE.StencilOp, plane: THREE.Plane): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    side,
    clippingPlanes: [plane],
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: operation,
    stencilZFail: operation,
    stencilZPass: operation,
  });
}

/**
 * The section tool's cut: clips the shown model's parts at one plane and caps the cut faces, so a
 * solid reads as solid rather than as an empty shell. The cap is the usual stencil trick: every
 * clipped part's back faces count up and its front faces count down, so a pixel of the cap plane
 * is inside some solid exactly where the count is not zero. Watertight parts (a manifold build)
 * cap cleanly; an opened asset with holes may cap where it should not.
 *
 * `group` holds the stencil copies and the cap. Add it to the scene, keep it out of the floor's
 * reflection (its render target has no stencil) and out of depth-only passes (ModelComposer),
 * which would draw the cap's whole quad.
 */
export class SectionCut {
  readonly plane = new THREE.Plane();
  readonly group = new THREE.Group();
  private readonly back = stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp, this.plane);
  private readonly front = stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp, this.plane);
  private readonly stencils = new THREE.Group();
  private readonly cap: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private clipped: THREE.Object3D | null = null;
  private on = false;

  constructor() {
    this.group.name = 'section-cut';
    this.cap = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        color: CAP_COLOR,
        roughness: 0.85,
        metalness: 0,
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      })
    );
    this.cap.name = 'section-cap';
    this.cap.renderOrder = 2;
    this.cap.frustumCulled = false;
    this.cap.receiveShadow = true;
    // The next frame (or pass) starts with a clean count.
    this.cap.onAfterRender = renderer => renderer.clearStencil();
    this.cap.visible = false;
    this.group.add(this.stencils, this.cap);
  }

  get active(): boolean {
    return this.on;
  }

  /**
   * Cuts `shown` as `state` says across `bounds` (the model's rest bounds, so the plane holds
   * still while parts pose or pull apart), or takes the cut away (null state or nothing shown).
   */
  apply(shown: THREE.Object3D | null, state: SectionState | null, bounds: THREE.Box3): void {
    const on = !!shown && !!state && !bounds.isEmpty();
    if (this.clipped && this.clipped !== shown) this.clip(this.clipped, false);
    if (!on || !shown || !state) {
      if (this.clipped) this.clip(this.clipped, false);
      this.clipped = null;
      this.clearStencils();
      this.cap.visible = false;
      this.on = false;
      return;
    }
    sectionPlane(state, bounds, this.plane);
    if (this.clipped !== shown || !this.on) {
      this.clip(shown, true);
      this.clipped = shown;
      this.buildStencils(shown);
    }
    this.placeCap(bounds);
    this.on = true;
  }

  dispose(): void {
    this.apply(null, null, new THREE.Box3());
    this.back.dispose();
    this.front.dispose();
    this.cap.geometry.dispose();
    this.cap.material.dispose();
  }

  private clip(root: THREE.Object3D, on: boolean): void {
    root.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials: THREE.Material[] = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) setClipPlane(material, this.plane, on);
    });
  }

  private clearStencils(): void {
    this.stencils.clear();
  }

  private buildStencils(root: THREE.Object3D): void {
    this.clearStencils();
    root.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      for (const material of [this.back, this.front]) {
        const copy = new THREE.Mesh(node.geometry, material);
        copy.matrixAutoUpdate = false;
        copy.frustumCulled = false;
        copy.renderOrder = 1;
        // Follows the part as it poses, explodes or plays a clip: the source's world matrix is
        // current by the time anything draws, since the scene updates it first.
        copy.onBeforeRender = () => copy.matrixWorld.copy(node.matrixWorld);
        this.stencils.add(copy);
      }
    });
  }

  private placeCap(bounds: THREE.Box3): void {
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3()).length() * 2;
    this.cap.position.copy(this.plane.projectPoint(centre, new THREE.Vector3()));
    this.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal);
    this.cap.scale.set(size, size, 1);
    this.cap.visible = true;
  }
}
