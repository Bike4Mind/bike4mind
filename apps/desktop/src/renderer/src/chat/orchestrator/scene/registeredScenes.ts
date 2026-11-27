import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from '../orchestratorViews';
import { ORCHESTRATOR_VIEW_INFO } from '../ViewSwitcher';
import { ORCHESTRATOR_VIEW_COMPONENTS } from '../viewRegistry';
import { sceneViewOf } from './SceneStage';
import type { SceneDefinition } from './sceneDefinition';

/** Every view the menu groups as a scene, in menu order; read from the registry so a new scene joins on its own. */
export const SCENE_VIEW_IDS: readonly OrchestratorViewId[] = ORCHESTRATOR_VIEWS.filter(
  view => ORCHESTRATOR_VIEW_INFO[view].group === 'scene'
);

/** The definition a scene view was registered with, or undefined when it is not a framework `sceneView`. */
export function registeredScene(view: OrchestratorViewId): SceneDefinition | undefined {
  return sceneViewOf(ORCHESTRATOR_VIEW_COMPONENTS[view])?.scene;
}
