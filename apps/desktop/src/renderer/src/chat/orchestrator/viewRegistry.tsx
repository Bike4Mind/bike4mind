import type { ComponentType, ReactNode } from 'react';
import { Aquarium } from './aquarium/Aquarium';
import { BoardView } from './BoardView';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { OrchestratorViewId } from './orchestratorPrefs';
import { snapshotView } from './snapshotView';
import { TableView } from './TableView';
import { TavernView } from './tavern/TavernView';
import { TileWall } from './TileWall';

const TileWallView = snapshotView(TileWall, { displayName: 'TileWallView' });
// Meant for a second monitor, so it keeps swimming while the window is unfocused; it still stops when hidden.
const AquariumView = snapshotView(Aquarium, { displayName: 'AquariumView', pause: { awake: true } });

/**
 * Each view's component, keyed by id so a new id in ORCHESTRATOR_VIEWS fails to compile until it has one
 * (its menu entry is ORCHESTRATOR_VIEW_INFO in ViewSwitcher). Kept out of the stage so the stage does not
 * import the views.
 */
export const ORCHESTRATOR_VIEW_COMPONENTS: Record<OrchestratorViewId, ComponentType<OrchestratorViewProps>> = {
  tavern: TavernView,
  aquarium: AquariumView,
  board: BoardView,
  table: TableView,
  'tile-wall': TileWallView,
};

export function renderOrchestratorView(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode {
  const View = ORCHESTRATOR_VIEW_COMPONENTS[view];
  return <View {...props} />;
}
