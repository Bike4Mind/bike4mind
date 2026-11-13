import { useMemo } from 'react';
import { assignPersonas } from '@shared/agentPersona';
import type { WatchOrchestration } from '@shared/watch';
import { buildRoster } from '../chat/orchestrator/roster';
import { TavernView } from '../chat/orchestrator/tavern/TavernView';

const NO_PR_SUMMARIES = new Map();

/**
 * One orchestration's Tavern, built from the snapshot the way the stage builds it from live state.
 * `awake` keeps it animating while unfocused, so a waiting agent still waves at the user.
 */
export function MiniRoom({
  orchestration,
  awake,
  onSelect,
}: {
  orchestration: WatchOrchestration;
  awake: boolean;
  onSelect(sessionId: string): void;
}) {
  const { sessions, statuses, activity, rootId, celebrate } = orchestration;
  const agents = useMemo(
    () =>
      buildRoster({
        sessions,
        statuses: new Map(Object.entries(statuses)),
        activity: new Map(Object.entries(activity)),
        prSummaries: NO_PR_SUMMARIES,
        rootId,
      }),
    [sessions, statuses, activity, rootId]
  );
  const personas = useMemo(() => assignPersonas(agents), [agents]);
  const parent = useMemo(
    () => ({
      ...(statuses[rootId] ? { status: statuses[rootId] } : {}),
      ...(activity[rootId] ? { activity: activity[rootId] } : {}),
    }),
    [statuses, activity, rootId]
  );

  return (
    <TavernView
      agents={agents}
      personas={personas}
      parent={parent}
      selectedId={null}
      introPlaying={false}
      celebrating={celebrate}
      onSelect={onSelect}
      onInnkeeperSelect={() => onSelect(rootId)}
      pause={{ unfocusedAfterMs: 0, awake }}
    />
  );
}
