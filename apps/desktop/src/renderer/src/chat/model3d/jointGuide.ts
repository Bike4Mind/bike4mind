import * as THREE from 'three';
import type { JointDragFrame } from './jointDrag';

const GUIDE_COLOR = new THREE.Color('#2f7cf6');
const LIMIT_COLOR = new THREE.Color('#f5a524');
const GUIDE_OPACITY = 0.85;
/** Fade in or out, in ms. */
const FADE_MS = 140;
/** How long a limit hit keeps the guide warm, in ms. */
const FLASH_MS = 320;
const ARC_SEGMENTS = 64;
/** The dot at the joint's value, and the ticks at its limits, as shares of the model's radius. */
const DOT_SIZE = 0.014;
const TICK_SIZE = 0.035;

/** A placement of the guide: where the joint is now, and the value it shows there. */
type Placement = { frame: JointDragFrame; value: number; centre: THREE.Vector3; radius: number; size: number };

/**
 * The thin hover-and-drag guide at a joint: an arc over a hinge's range about its pivot, or a line
 * over a slide's travel, with a tick at each limit and a dot at the current value. It sits in the
 * scene over the model (no depth test, no shadows, never hit by a pick) and animates its own fade
 * and limit flash; `tick` advances them and says whether another frame is wanted.
 */
export class JointGuide {
  readonly object = new THREE.Group();
  private readonly lineMaterial = new THREE.LineBasicMaterial({
    color: GUIDE_COLOR.clone(),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly dotMaterial = new THREE.MeshBasicMaterial({
    color: GUIDE_COLOR.clone(),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly track = new THREE.Line(new THREE.BufferGeometry(), this.lineMaterial);
  private readonly ticks = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMaterial);
  private readonly dot = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), this.dotMaterial);
  private placement: Placement | null = null;
  private opacity = 0;
  private targetOpacity = 0;
  private flashedAt = -Infinity;
  private lastTick: number | null = null;

  constructor(private readonly reducedMotion: () => boolean) {
    this.object.name = 'joint-guide';
    this.object.renderOrder = 1000;
    for (const child of [this.track, this.ticks, this.dot]) {
      child.renderOrder = 1000;
      child.castShadow = false;
      child.receiveShadow = false;
      child.raycast = () => {};
      this.object.add(child);
    }
    this.object.visible = false;
    this.applyLook(0);
  }

  /** Whether the guide is showing (or fading in) for a joint. */
  get shown(): boolean {
    return this.targetOpacity > 0;
  }

  /**
   * Places the guide for `frame` at `value`. `centre` is the moving part's centre in world space,
   * which sets the arc's radius and where a slide's line runs; `size` is the model's radius.
   */
  show(frame: JointDragFrame, value: number, centre: THREE.Vector3, size: number): void {
    const fromAxis = centre.clone().sub(frame.pivot);
    fromAxis.addScaledVector(frame.axis, -fromAxis.dot(frame.axis));
    const radius = Math.max(fromAxis.length(), size * 0.25);
    this.placement = { frame, value, centre: centre.clone(), radius, size };
    this.buildTrack();
    this.setValue(value);
    this.object.visible = true;
    this.targetOpacity = 1;
    if (this.reducedMotion()) this.opacity = 1;
  }

  /** Moves the dot to `value` (the shown pose, which may overshoot a limit a little). */
  setValue(value: number): void {
    const placement = this.placement;
    if (!placement) return;
    this.dot.position.copy(this.pointAt(value));
    this.dot.scale.setScalar(placement.size * DOT_SIZE);
  }

  /** Warms the guide for a moment: a limit was reached. */
  flash(now: number): void {
    this.flashedAt = now;
  }

  hide(): void {
    this.targetOpacity = 0;
    if (this.reducedMotion()) this.opacity = 0;
  }

  /** Advances the fade and flash to `now` (ms); true while another frame would change the look. */
  tick(now: number): boolean {
    const elapsed = this.lastTick === null ? 0 : now - this.lastTick;
    this.lastTick = now;
    const step = this.reducedMotion() ? 1 : elapsed / FADE_MS;
    this.opacity =
      this.targetOpacity > this.opacity
        ? Math.min(this.targetOpacity, this.opacity + step)
        : Math.max(this.targetOpacity, this.opacity - step);
    const sinceFlash = now - this.flashedAt;
    const warmth = this.reducedMotion() ? (sinceFlash < FLASH_MS ? 1 : 0) : Math.max(0, 1 - sinceFlash / FLASH_MS);
    this.applyLook(warmth);
    this.object.visible = this.opacity > 0;
    if (!this.object.visible) this.lastTick = null;
    return this.opacity !== this.targetOpacity || warmth > 0;
  }

  dispose(): void {
    this.track.geometry.dispose();
    this.ticks.geometry.dispose();
    this.dot.geometry.dispose();
    this.lineMaterial.dispose();
    this.dotMaterial.dispose();
    this.object.removeFromParent();
  }

  private applyLook(warmth: number): void {
    const color = GUIDE_COLOR.clone().lerp(LIMIT_COLOR, warmth);
    this.lineMaterial.color.copy(color);
    this.dotMaterial.color.copy(color);
    this.lineMaterial.opacity = GUIDE_OPACITY * this.opacity;
    this.dotMaterial.opacity = this.opacity;
  }

  /** Where the guide shows `value`, in world space. */
  private pointAt(value: number): THREE.Vector3 {
    const { frame, value: placedAt, centre, radius } = this.placement!;
    if (frame.motion === 'slide') {
      return centre.clone().addScaledVector(frame.axis, (value - placedAt) * frame.scale);
    }
    // The arc's zero is wherever the part's centre sits now, at the value it was placed at.
    const u = centre.clone().sub(frame.pivot);
    u.addScaledVector(frame.axis, -u.dot(frame.axis));
    if (u.lengthSq() < 1e-12) u.copy(anyPerpendicular(frame.axis));
    u.normalize();
    const v = frame.axis.clone().cross(u);
    const angle = THREE.MathUtils.degToRad(value - placedAt);
    return frame.pivot
      .clone()
      .addScaledVector(u, Math.cos(angle) * radius)
      .addScaledVector(v, Math.sin(angle) * radius);
  }

  private buildTrack(): void {
    const { frame, size } = this.placement!;
    const [from, to] = frame.range;
    const points: THREE.Vector3[] = [];
    const segments = frame.motion === 'slide' ? 1 : ARC_SEGMENTS;
    for (let index = 0; index <= segments; index += 1)
      points.push(this.pointAt(from + ((to - from) * index) / segments));
    this.track.geometry.setFromPoints(points);
    // A short tick across the track at each limit: radial for an arc, square to the line for a slide.
    const tick = size * TICK_SIZE;
    const tickPoints = [from, to].flatMap(limit => {
      const at = this.pointAt(limit);
      const across =
        frame.motion === 'slide'
          ? anyPerpendicular(frame.axis)
          : at.clone().sub(frame.pivot).addScaledVector(frame.axis, -at.clone().sub(frame.pivot).dot(frame.axis));
      across.normalize().multiplyScalar(tick / 2);
      return [at.clone().sub(across), at.clone().add(across)];
    });
    this.ticks.geometry.setFromPoints(tickPoints);
  }
}

/** Some unit vector square to `axis`. */
function anyPerpendicular(axis: THREE.Vector3): THREE.Vector3 {
  const helper = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return helper.cross(axis).normalize();
}
