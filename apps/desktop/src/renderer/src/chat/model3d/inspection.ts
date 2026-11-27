import * as THREE from 'three';
import { formatLength, measureResult } from './measure';
import { MeasureOverlay } from './measureOverlay';
import type { SectionState } from './section';
import { SectionCut } from './sectionCut';
import type { ModelComposer, ModelStage } from './modelStage';

/** The model pane's inspection tools; at most one is on at a time. */
export type ModelTool = 'measure' | 'section';

/**
 * What the pane's tools show now, so a rendered still (renderContactSheet, the agent's
 * model_screenshot) carries the same cut and dimension the user is looking at.
 */
export type ModelInspection = {
  section: SectionState | null;
  /** The picked points, world space, and the model's units for the label. */
  measure: { points: THREE.Vector3[]; units: string } | null;
};

/** The dimension label: the distance and the model's units. */
export function measureLabel(points: readonly THREE.Vector3[], units: string): string | null {
  const result = measureResult(points);
  return result ? `${formatLength(result.distance)} ${units}` : null;
}

/**
 * Puts `inspection`'s cut and dimension into an off-screen still's scene. Returns the cleanup,
 * which the caller runs before disposing of its stage and composer.
 */
export function addInspection(
  scene: THREE.Scene,
  subject: THREE.Object3D,
  stage: ModelStage,
  composer: ModelComposer,
  inspection: ModelInspection,
  aspect: number
): () => void {
  const cut = new SectionCut();
  const overlay = new MeasureOverlay();
  scene.add(cut.group, overlay.group);
  stage.unreflected.add(cut.group);
  stage.unreflected.add(overlay.group);
  cut.apply(subject, inspection.section, stage.bounds);
  composer.setInspection([cut.group, overlay.group], cut.active ? cut.plane : null);
  overlay.setAspect(aspect);
  if (inspection.measure) {
    const { points, units } = inspection.measure;
    overlay.setPoints(points, measureLabel(points, units));
  }
  return () => {
    composer.setInspection([], null);
    stage.unreflected.delete(cut.group);
    stage.unreflected.delete(overlay.group);
    scene.remove(cut.group, overlay.group);
    cut.dispose();
    overlay.dispose();
  };
}
