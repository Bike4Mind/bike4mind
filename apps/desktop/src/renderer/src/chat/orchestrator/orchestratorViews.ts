export type OrchestratorViewId =
  'tavern' | 'aquarium' | 'office' | 'board' | 'table' | 'plan' | 'tile-wall' | 'swimlanes' | 'constellation' | 'transit';
/** Menu and Mod+Shift+[ / ] order: the scenes, then the layouts (ViewSwitcher groups them the same way). */
export const ORCHESTRATOR_VIEWS: readonly OrchestratorViewId[] = [
  'tavern',
  'aquarium',
  'office',
  'board',
  'table',
  'plan',
  'tile-wall',
  'swimlanes',
  'constellation',
  'transit',
];

/** A stored or typed string as a view id, or undefined when it is not (or no longer) one. */
export function toViewId(value: unknown): OrchestratorViewId | undefined {
  return ORCHESTRATOR_VIEWS.find(view => view === value);
}
