import type { ComponentType, ReactNode } from 'react';
import { Aquarium } from './aquarium/Aquarium';
import { BoardView } from './BoardView';
import { Constellation } from './Constellation';
import { PlanView } from './PlanView';
import { OfficeView } from './office/OfficeView';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { OrchestratorViewId } from './orchestratorPrefs';
import { snapshotView } from './snapshotView';
import { Swimlanes } from './Swimlanes';
import { TableView } from './TableView';
import { TavernView } from './tavern/TavernView';
import { TileWall } from './TileWall';
import { Transit } from './Transit';

const TileWallView = snapshotView(TileWall, { displayName: 'TileWallView' });
const SwimlanesView = snapshotView(Swimlanes, { displayName: 'SwimlanesView' });
const ConstellationView = snapshotView(Constellation, { displayName: 'ConstellationView' });
const PlanSnapshotView = snapshotView(PlanView, { displayName: 'PlanView' });
const TransitView = snapshotView(Transit, { displayName: 'TransitView' });
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
  office: OfficeView,
  board: BoardView,
  table: TableView,
  plan: PlanSnapshotView,
  'tile-wall': TileWallView,
  swimlanes: SwimlanesView,
  constellation: ConstellationView,
  transit: TransitView,
};

export function renderOrchestratorView(view: OrchestratorViewId, props: OrchestratorViewProps): ReactNode {
  const View = ORCHESTRATOR_VIEW_COMPONENTS[view];
  return <View {...props} />;
}
