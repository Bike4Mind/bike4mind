import * as THREE from 'three';
import { toModelFrame } from './modelFrame';

/** Screen px within which a pick snaps to a corner of the model. */
export const VERTEX_SNAP_PX = 10;
/** Screen px within which a pick snaps onto an edge of the model. */
export const EDGE_SNAP_PX = 7;
/**
 * Edges where the faces meet at more than this angle (degrees) are snap targets: the diagonals
 * that split a flat face into triangles, and the facets of a smooth curve, are not.
 */
export const FEATURE_EDGE_ANGLE = 20;

export type SnapKind = 'vertex' | 'edge' | 'surface';

/** A picked measuring point in world space, with the surface normal it was picked on. */
export type MeasurePoint = { point: THREE.Vector3; normal: THREE.Vector3; kind: SnapKind };

/** Projects a world point to screen px. */
export type ToScreen = (world: THREE.Vector3) => THREE.Vector2;

/**
 * Snaps a surface hit to the nearest corner of a feature edge within VERTEX_SNAP_PX of the
 * cursor, else to the nearest point on a feature edge within EDGE_SNAP_PX, else keeps the hit.
 * `edges` are world-space segments; corners are their ends.
 */
export function snapPoint(
  hit: THREE.Vector3,
  cursor: THREE.Vector2,
  edges: readonly THREE.Line3[],
  toScreen: ToScreen
): { point: THREE.Vector3; kind: SnapKind } {
  let corner: THREE.Vector3 | null = null;
  let cornerPx = VERTEX_SNAP_PX;
  let onEdge: THREE.Vector3 | null = null;
  let edgePx = EDGE_SNAP_PX;
  const closest = new THREE.Vector3();
  for (const edge of edges) {
    for (const end of [edge.start, edge.end]) {
      const px = toScreen(end).distanceTo(cursor);
      if (px <= cornerPx) {
        cornerPx = px;
        corner = end;
      }
    }
    edge.closestPointToPoint(hit, true, closest);
    const px = toScreen(closest).distanceTo(cursor);
    if (px <= edgePx) {
      edgePx = px;
      onEdge = closest.clone();
    }
  }
  if (corner) return { point: corner.clone(), kind: 'vertex' };
  if (onEdge) return { point: onEdge, kind: 'edge' };
  return { point: hit.clone(), kind: 'surface' };
}

const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>();

/** The mesh's feature edges (see FEATURE_EDGE_ANGLE) in world space as it is posed now. */
export function featureEdges(mesh: THREE.Mesh): THREE.Line3[] {
  let edges = edgeCache.get(mesh.geometry);
  if (!edges) {
    edges = new THREE.EdgesGeometry(mesh.geometry, FEATURE_EDGE_ANGLE);
    edgeCache.set(mesh.geometry, edges);
  }
  mesh.updateWorldMatrix(true, false);
  const position = edges.getAttribute('position');
  const lines: THREE.Line3[] = [];
  for (let index = 0; index + 1 < position.count; index += 2) {
    lines.push(
      new THREE.Line3(
        new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld),
        new THREE.Vector3().fromBufferAttribute(position, index + 1).applyMatrix4(mesh.matrixWorld)
      )
    );
  }
  return lines;
}

/** The points of a measurement: a click after the second starts a new one. */
export function addMeasurePoint(points: readonly MeasurePoint[], next: MeasurePoint): MeasurePoint[] {
  return points.length >= 2 ? [next] : [...points, next];
}

/** A finished measurement's distance and its run along each of the model's own axes, in model units. */
export type MeasureResult = { distance: number; delta: [number, number, number] };

export function measureResult(points: readonly THREE.Vector3[]): MeasureResult | null {
  if (points.length < 2) return null;
  const delta = toModelFrame(points[1].clone().sub(points[0]));
  return {
    distance: delta.length(),
    delta: [Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)],
  };
}

/** A length for the readout: more decimals the smaller it is, without trailing zeros. */
export function formatLength(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  const digits = magnitude >= 100 ? 1 : magnitude >= 1 ? 2 : Math.max(2, 2 - Math.floor(Math.log10(magnitude)));
  return String(Number(value.toFixed(Math.min(digits, 6))));
}

/**
 * Whether a point picked on the model before a rebuild is still on its surface: a short ray cast
 * back along the normal it was picked on, `tolerance` (world units) either side, still hits it.
 */
export function stillOnSurface(root: THREE.Object3D, picked: MeasurePoint, tolerance: number): boolean {
  const origin = picked.point.clone().addScaledVector(picked.normal, tolerance);
  const raycaster = new THREE.Raycaster(origin, picked.normal.clone().negate(), 0, tolerance * 2);
  return raycaster.intersectObject(root, true).some(entry => entry.object instanceof THREE.Mesh);
}
