import * as THREE from 'three';
import type { SnapKind } from './measure';

const LINE_COLOR = new THREE.Color('#ffc53d');
const HOVER_COLORS: Record<SnapKind, THREE.Color> = {
  vertex: new THREE.Color('#ff5c8a'),
  edge: new THREE.Color('#3ddc97'),
  surface: new THREE.Color('#ffffff'),
};
/** Marker size, in px. */
const MARKER_PX = 9;
/** Label height as a share of the viewport's height. */
const LABEL_HEIGHT = 0.042;
const LABEL_FONT_PX = 44;

/** Drawn over the model rather than hidden by it, last, and outside depth-only passes (see ModelComposer). */
function onTop<T extends THREE.Material>(material: T): T {
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  return material;
}

/**
 * The measure tool's dimension: a line between the two picked points with a marker at each end,
 * the distance on a label at its middle, and a marker under the cursor showing what a click would
 * snap to. All in the scene (not DOM) so a rendered still carries it too.
 */
export class MeasureOverlay {
  readonly group = new THREE.Group();
  private readonly line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly ends: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly hover: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly label: THREE.Sprite;
  private labelText: string | null = null;
  private aspect = 1;

  constructor() {
    this.group.name = 'measure-overlay';
    this.group.renderOrder = 10;
    this.line = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
      onTop(new THREE.LineBasicMaterial({ color: LINE_COLOR }))
    );
    this.ends = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)),
      onTop(new THREE.PointsMaterial({ color: LINE_COLOR, size: MARKER_PX, sizeAttenuation: false }))
    );
    this.hover = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3), 3)),
      onTop(new THREE.PointsMaterial({ size: MARKER_PX + 2, sizeAttenuation: false }))
    );
    this.label = new THREE.Sprite(onTop(new THREE.SpriteMaterial({ sizeAttenuation: false })));
    this.label.center.set(0.5, -0.35);
    for (const object of [this.line, this.ends, this.hover, this.label]) {
      object.renderOrder = 10;
      object.frustumCulled = false;
      object.visible = false;
      this.group.add(object);
    }
  }

  /** Shows the picked points (none, one or two) and, with two, the line and `text` on its label. */
  setPoints(points: readonly THREE.Vector3[], text: string | null): void {
    const ends = this.ends.geometry.getAttribute('position') as THREE.BufferAttribute;
    points.slice(0, 2).forEach((point, index) => ends.setXYZ(index, point.x, point.y, point.z));
    ends.needsUpdate = true;
    this.ends.geometry.setDrawRange(0, Math.min(points.length, 2));
    this.ends.visible = points.length > 0;
    const both = points.length >= 2;
    this.line.visible = both;
    this.label.visible = both && !!text;
    if (!both) return;
    const line = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    line.setXYZ(0, points[0].x, points[0].y, points[0].z);
    line.setXYZ(1, points[1].x, points[1].y, points[1].z);
    line.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    this.label.position.copy(points[0]).add(points[1]).multiplyScalar(0.5);
    if (text && text !== this.labelText) this.drawLabel(text);
  }

  /** The marker under the cursor and what it snapped to, or none. */
  setHover(point: THREE.Vector3 | null, kind: SnapKind = 'surface'): void {
    this.hover.visible = !!point;
    if (!point) return;
    const position = this.hover.geometry.getAttribute('position') as THREE.BufferAttribute;
    position.setXYZ(0, point.x, point.y, point.z);
    position.needsUpdate = true;
    this.hover.material.color.copy(HOVER_COLORS[kind]);
  }

  /** Rescales the label for the viewport's aspect, so it keeps its shape in a wide or tall pane. */
  setAspect(aspect: number): void {
    this.aspect = aspect;
    const image = this.label.material.map?.image as HTMLCanvasElement | undefined;
    const ratio = image ? image.width / image.height : 4;
    this.label.scale.set((LABEL_HEIGHT * ratio) / Math.max(aspect, 1e-3), LABEL_HEIGHT, 1);
  }

  clear(): void {
    this.setPoints([], null);
    this.setHover(null);
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.line.material.dispose();
    this.ends.geometry.dispose();
    this.ends.material.dispose();
    this.hover.geometry.dispose();
    this.hover.material.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }

  private drawLabel(text: string): void {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    // No 2D canvas (a test DOM): the line and markers still show.
    if (!context) return;
    const font = `600 ${LABEL_FONT_PX}px -apple-system, system-ui, sans-serif`;
    context.font = font;
    const padding = LABEL_FONT_PX * 0.45;
    canvas.width = Math.ceil(context.measureText(text).width + padding * 2);
    canvas.height = Math.ceil(LABEL_FONT_PX + padding * 1.4);
    context.font = font;
    context.fillStyle = 'rgba(20, 22, 26, 0.86)';
    context.beginPath();
    context.roundRect(0, 0, canvas.width, canvas.height, canvas.height / 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
    this.label.material.map?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.label.material.map = texture;
    this.label.material.needsUpdate = true;
    this.labelText = text;
    this.setAspect(this.aspect);
  }
}
