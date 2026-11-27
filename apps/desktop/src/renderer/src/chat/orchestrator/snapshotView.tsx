import Box from '@mui/joy/Box';
import { useMemo, type ComponentType, type ReactNode } from 'react';
import { acceptViewAction, type ViewAction, type ViewSnapshot } from '@shared/viewSnapshot';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { useScenePause, type ScenePauseOptions } from './scene/useScenePause';
import { runViewAction, toViewSnapshot } from './viewSnapshot';

/** All a snapshot view is given: the read-only picture, and the one way to ask the host for something. */
export interface SnapshotViewProps {
  snapshot: ViewSnapshot;
  onAction(action: ViewAction): void;
  agentDetailsOverlay?: ReactNode;
}

/** Stands in for the root's id when the stage was not given one; the root is only ever opened, never looked up. */
const UNNAMED_ROOT = 'orchestrator';
const NO_PARENT = {};

/**
 * Hosts a view that sees only the snapshot (@shared/viewSnapshot), as FocusPanel does in the stage: the
 * snapshot is built from the stage's props here, and every action goes through acceptViewAction before it
 * selects an agent or opens the root. The host also owns pausing (useScenePause, tuned by `pause`), so a
 * hidden window stops every animation under it without the view knowing about windows.
 */
export function snapshotView(
  View: ComponentType<SnapshotViewProps>,
  { displayName, pause }: { displayName: string; pause?: ScenePauseOptions }
) {
  function SnapshotHost({
    agents,
    parent,
    rootId,
    onSelect,
    onOpenPr,
    onInnkeeperSelect,
    agentDetailsOverlay,
    restoreAction,
  }: OrchestratorViewProps) {
    const snapshot = useMemo(
      () => toViewSnapshot(rootId ?? UNNAMED_ROOT, agents, parent ?? NO_PARENT),
      [rootId, agents, parent]
    );
    const paused = useScenePause(pause);

    // This host reads no quick approvals and has no Stop: an approve is never in its snapshot and a stop rejects.
    const onAction = (action: ViewAction) => {
      const accepted = acceptViewAction(snapshot, action);
      if (!accepted) return;
      const reportFailure = (error: unknown) => console.error('A view action failed', error);
      // Presenter mode hands this host a redacted roster, so an answer names placeholder labels until restored.
      let real: ViewAction;
      try {
        real = restoreAction ? restoreAction(accepted) : accepted;
      } catch (error) {
        reportFailure(error);
        return;
      }
      runViewAction(real, { openAgent: onSelect, openPr: onOpenPr, openRoot: () => onInnkeeperSelect?.() }).catch(
        reportFailure
      );
    };

    return (
      <Box
        data-paused={paused}
        sx={{
          flex: 1,
          display: 'flex',
          minHeight: 0,
          '&[data-paused] *, &[data-paused] *::before, &[data-paused] *::after': {
            animationPlayState: 'paused !important',
          },
        }}
      >
        <View snapshot={snapshot} onAction={onAction} agentDetailsOverlay={agentDetailsOverlay} />
      </Box>
    );
  }
  SnapshotHost.displayName = displayName;
  return SnapshotHost;
}
