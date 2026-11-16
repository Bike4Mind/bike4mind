import type { ComponentType, ReactNode } from 'react';
import { BoardView } from './BoardView';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { OrchestratorViewId } from './orchestratorPrefs';
import { TableView } from './TableView';
import { TavernView } from './tavern/TavernView';

/**
 * Each view's component, keyed by id so a new id in ORCHESTRATOR_VIEWS fails to compile until it has one
 * (its menu entry is ORCHESTRATOR_VIEW_INFO in ViewSwitcher). Kept out of the stage so the stage does not
 * import the views.
 */
export const ORCHESTRATOR_VIEW_COMPONENTS: Record<OrchestratorViewId, ComponentType<OrchestratorViewProps>> = {
  tavern: TavernView,
  board: BoardView,
  table: TableView,
};

export function renderOrchestratorView(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode {
  const View = ORCHESTRATOR_VIEW_COMPONENTS[view];
  return <View {...props} />;
}
