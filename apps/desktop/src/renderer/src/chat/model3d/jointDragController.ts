import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  beginJointDrag,
  jointDragValue,
  overshootCap,
  snapValue,
  softClamp,
  type JointDrag,
  type ScreenPoint,
} from './jointDrag';
import { JointGuide } from './jointGuide';
import { drivingJoint, jointDragFrame, poseJoints } from './modelScene';

/** Pointer travel, in CSS px, under which a press and release is a click rather than a drag or an orbit. */
export const CLICK_SLOP = 4;
/** How long a released overshoot eases back to the limit, in ms. */
const SETTLE_MS = 180;
/** How long Esc takes to carry a joint back to where the drag began, in ms. */
const REVERT_MS = 220;

export type JointDragDeps = {
  /** The viewport's host element: presses are claimed in its capture phase, before OrbitControls sees them. */
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  scene: THREE.Scene;
  /** The viewer's posed copy of the model, or null with nothing shown. */
  shown(): THREE.Object3D | null;
  /** The shared joint values, as the sliders show them. */
  pose(): Record<string, number>;
  /** False while something else owns the view (a turntable recording). */
  enabled(): boolean;
  /** A dragged joint's value, always within its range. */
  onChange(name: string, value: number): void;
  /** A drag began: the joints' Play loop should stop. */
  onStart(): void;
  /** Draws a frame. The viewer holds its idle AO pass back while `busy` is true. */
  render(): void;
};

type Press = {
  pointerId: number;
  /** Client px at press, for the click slop. */
  from: ScreenPoint;
  node: THREE.Object3D;
  grab: THREE.Vector3;
  start: number;
  drag: JointDrag | null;
  /** Esc was pressed: the rest of this press does nothing. */
  cancelled: boolean;
  lastPointer: ScreenPoint;
  lastSnap: boolean;
  limit: 'low' | 'high' | null;
  value: number;
};

type Tween = { name: string; from: number; to: number; started: number; ms: number };

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * Direct manipulation of a model's joints in the viewer: hover a movable part for a guide, press
 * and drag it about its hinge or along its slide (jointDrag.ts maps the pointer). A press that
 * stays within CLICK_SLOP is left to the viewer as a click (point-and-edit picks); one past it is
 * a drag and never picks. Values go to `onChange` clamped to the range; the viewer alone shows a
 * small overshoot at a limit, which eases back on release. Shift snaps, Esc reverts.
 */
export class JointDragController {
  private readonly guide = new JointGuide(reducedMotion);
  private press: Press | null = null;
  /** The value the viewer shows for one joint in place of the shared one: an overshoot or a settle. */
  private override: { name: string; shown: number } | null = null;
  private tween: Tween | null = null;
  private hovered: THREE.Object3D | null = null;
  private hoverPointer: ScreenPoint | null = null;
  private hoverFrame = 0;
  private loopFrame = 0;
  private looping = false;

  constructor(private readonly deps: JointDragDeps) {
    deps.scene.add(this.guide.object);
    deps.host.addEventListener('pointerdown', this.onPointerDown, true);
    deps.host.addEventListener('pointermove', this.onPointerMove, true);
    deps.host.addEventListener('pointerup', this.onPointerUp, true);
    deps.host.addEventListener('pointercancel', this.onPointerUp, true);
    deps.host.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
  }

  /** True while a drag, a settle or a guide fade is running: the viewer holds its AO pass until it ends. */
  get busy(): boolean {
    return !!this.press?.drag || this.looping;
  }

  /** `pose` with the viewer's own value for the joint being dragged or settling. */
  posed(pose: Record<string, number>): Record<string, number> {
    return this.override ? { ...pose, [this.override.name]: this.override.shown } : pose;
  }

  /** The shown model was replaced (a rebuild): drop the hover and any drag on the old copy. */
  reset(): void {
    if (this.press) this.endPress();
    this.override = null;
    this.tween = null;
    this.setHovered(null);
  }

  dispose(): void {
    const { host } = this.deps;
    host.removeEventListener('pointerdown', this.onPointerDown, true);
    host.removeEventListener('pointermove', this.onPointerMove, true);
    host.removeEventListener('pointerup', this.onPointerUp, true);
    host.removeEventListener('pointercancel', this.onPointerUp, true);
    host.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    cancelAnimationFrame(this.hoverFrame);
    cancelAnimationFrame(this.loopFrame);
    this.guide.dispose();
  }

  private local(event: { clientX: number; clientY: number }): ScreenPoint {
    const bounds = this.deps.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  /** The joint node under `point` and the world point hit on it, or null. */
  private jointAt(point: ScreenPoint): { node: THREE.Object3D; hit: THREE.Vector3 } | null {
    const shown = this.deps.shown();
    if (!shown) return null;
    const bounds = this.deps.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2((point.x / bounds.width) * 2 - 1, 1 - (point.y / bounds.height) * 2),
      this.deps.camera
    );
    const hit = raycaster.intersectObject(shown, true).find(entry => entry.object instanceof THREE.Mesh);
    const node = hit ? drivingJoint(hit.object) : null;
    return hit && node ? { node, hit: hit.point } : null;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.deps.enabled() || this.press) return;
    const found = this.jointAt(this.local(event));
    if (!found) return;
    // Claimed before OrbitControls' own listener runs: it ignores a press while disabled.
    this.deps.controls.enabled = false;
    this.tween = null;
    this.override = null;
    const point = this.local(event);
    this.press = {
      pointerId: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      node: found.node,
      grab: found.hit,
      start: this.deps.pose()[found.node.name] ?? 0,
      drag: null,
      cancelled: false,
      lastPointer: point,
      lastSnap: event.shiftKey,
      limit: null,
      value: this.deps.pose()[found.node.name] ?? 0,
    };
    try {
      this.deps.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-released pointer: the drag still works while the pointer stays over the view.
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    const press = this.press;
    if (!press) {
      if (event.buttons === 0 && this.deps.enabled()) this.scheduleHover(this.local(event));
      return;
    }
    if (event.pointerId !== press.pointerId || press.cancelled) return;
    if (!press.drag) {
      if (Math.hypot(event.clientX - press.from.x, event.clientY - press.from.y) <= CLICK_SLOP) return;
      this.beginDrag(press);
    }
    press.lastPointer = this.local(event);
    press.lastSnap = event.shiftKey;
    this.update(press);
  };

  private onPointerUp = (event: PointerEvent) => {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    // A drag (or an Esc'd press) is not a click: keep the viewer's pick handler from seeing it.
    if (press.drag || press.cancelled) event.stopPropagation();
    const dragged = !!press.drag && !press.cancelled;
    this.endPress();
    if (dragged) this.settle(press);
  };

  private onPointerLeave = () => {
    if (!this.press) this.setHovered(null);
  };

  private onKey = (event: KeyboardEvent) => {
    const press = this.press;
    if (!press?.drag || press.cancelled) return;
    if (event.key === 'Shift') {
      press.lastSnap = event.type === 'keydown';
      this.update(press);
      return;
    }
    if (event.type !== 'keydown' || event.key !== 'Escape') return;
    // The pane's own Esc clears the selection; mid-drag it only reverts the drag.
    event.preventDefault();
    event.stopPropagation();
    press.cancelled = true;
    const name = press.node.name;
    this.deps.onChange(name, press.start);
    this.startTween(name, this.override?.shown ?? press.value, press.start, REVERT_MS);
  };

  private beginDrag(press: Press): void {
    const bounds = this.deps.canvas.getBoundingClientRect();
    const frame = jointDragFrame(press.node);
    const at = { x: press.from.x - bounds.left, y: press.from.y - bounds.top };
    press.drag = beginJointDrag(
      frame,
      { camera: this.deps.camera, width: bounds.width, height: bounds.height },
      press.grab,
      at,
      press.start
    );
    this.deps.onStart();
    this.deps.canvas.style.cursor = 'grabbing';
    this.showGuide(press.node, press.start);
  }

  private update(press: Press): void {
    const drag = press.drag;
    if (!drag) return;
    const { motion, range } = drag.frame;
    const raw = jointDragValue(drag, press.lastPointer);
    const result = press.lastSnap
      ? (() => {
          const value = snapValue(raw, motion, range);
          return { value, shown: value, limit: softClamp(value, range, 0).limit };
        })()
      : softClamp(raw, range, reducedMotion() ? 0 : overshootCap(motion, range));
    if (result.limit && result.limit !== press.limit) this.guide.flash(performance.now());
    press.limit = result.limit;
    const name = press.node.name;
    this.override = { name, shown: result.shown };
    if (result.value !== press.value) {
      press.value = result.value;
      this.deps.onChange(name, result.value);
    }
    this.guide.setValue(result.shown);
    this.applyPose();
    this.kick();
  }

  /** Eases an overshoot back to the clamped value after release. */
  private settle(press: Press): void {
    const shown = this.override?.shown ?? press.value;
    if (shown === press.value || reducedMotion()) {
      this.override = null;
      this.applyPose();
      this.kick();
      return;
    }
    this.startTween(press.node.name, shown, press.value, SETTLE_MS);
  }

  private endPress(): void {
    const press = this.press;
    if (!press) return;
    this.press = null;
    this.deps.controls.enabled = true;
    try {
      if (this.deps.canvas.hasPointerCapture(press.pointerId)) this.deps.canvas.releasePointerCapture(press.pointerId);
    } catch {
      // Already released.
    }
    this.deps.canvas.style.cursor = this.hovered ? 'grab' : '';
  }

  private startTween(name: string, from: number, to: number, ms: number): void {
    if (reducedMotion()) {
      this.override = null;
      this.tween = null;
      this.applyPose();
      this.kick();
      return;
    }
    this.override = { name, shown: from };
    this.tween = { name, from, to, started: performance.now(), ms };
    this.kick();
  }

  private applyPose(): void {
    const shown = this.deps.shown();
    if (shown) poseJoints(shown, this.posed(this.deps.pose()));
  }

  /** Runs frames while a tween or a guide fade is moving, then lets the viewer draw its full frame. */
  private kick(): void {
    if (this.looping) return;
    this.looping = true;
    const step = (now: number) => {
      const tween = this.tween;
      if (tween) {
        const t = Math.min(1, (now - tween.started) / tween.ms);
        const shown = tween.from + (tween.to - tween.from) * easeOutCubic(t);
        this.override = t < 1 ? { name: tween.name, shown } : null;
        this.guide.setValue(shown);
        if (t >= 1) this.tween = null;
        this.applyPose();
      }
      const fading = this.guide.tick(now);
      const more = !!this.tween || fading;
      if (!more) this.looping = false;
      this.deps.render();
      if (more) this.loopFrame = requestAnimationFrame(step);
    };
    this.loopFrame = requestAnimationFrame(step);
  }

  private scheduleHover(point: ScreenPoint): void {
    this.hoverPointer = point;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      if (this.press || !this.hoverPointer) return;
      this.setHovered(this.jointAt(this.hoverPointer)?.node ?? null);
    });
  }

  private setHovered(node: THREE.Object3D | null): void {
    if (node === this.hovered) return;
    this.hovered = node;
    this.deps.canvas.style.cursor = node ? 'grab' : '';
    if (node) this.showGuide(node, this.deps.pose()[node.name] ?? 0);
    else this.guide.hide();
    this.kick();
  }

  private showGuide(node: THREE.Object3D, value: number): void {
    const shown = this.deps.shown();
    if (!shown) return;
    const centre = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
    const size = new THREE.Box3().setFromObject(shown).getBoundingSphere(new THREE.Sphere()).radius;
    this.guide.show(jointDragFrame(node), value, centre, size);
  }
}
