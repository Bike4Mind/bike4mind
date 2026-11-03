import { activityLabel } from '../activity';
import type { AgentState, AgentView, ParentView } from '../roster';
import type { InnkeeperPose } from './tavernArt';

export type InnkeeperAct = { pose: Exclude<InnkeeperPose, 'walking'> } | { pose: 'walking'; target: string };

/** Tools whose `session_id` is a child the parent is checking on, so the Innkeeper walks over to it. */
const VISIT_TOOLS: ReadonlySet<string> = new Set(['session_read', 'session_send']);
const SETTLED: ReadonlySet<AgentState> = new Set(['done', 'failed', 'stopped', 'idle']);

export const isParentBusy = (parent: ParentView) => parent.status === 'processing' || parent.status === 'needs-action';

/**
 * What the Innkeeper is doing, from the parent's live activity: checking on an agent, posting quests,
 * combining results once every agent has settled, or polishing the bar.
 */
export function innkeeperAct(parent: ParentView, agents: readonly AgentView[]): InnkeeperAct {
  if (!isParentBusy(parent)) return { pose: 'idle' };
  const activity = parent.activity;
  if (activity?.kind === 'tool') {
    const target = activity.target;
    if (VISIT_TOOLS.has(activity.tool) && target && agents.some(agent => agent.id === target)) {
      return { pose: 'walking', target };
    }
    if (activity.tool === 'session_spawn') return { pose: 'writing' };
  }
  if (agents.length === 0) return { pose: 'writing' };
  if (agents.every(agent => SETTLED.has(agent.state))) return { pose: 'reading' };
  return { pose: 'idle' };
}

export function innkeeperBubble(parent: ParentView): string | undefined {
  if (parent.status === 'needs-action') return 'Needs you!';
  if (parent.status === 'processing' && parent.activity) return activityLabel(parent.activity);
  return undefined;
}
