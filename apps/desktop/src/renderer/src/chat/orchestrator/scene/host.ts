import { activityLabel } from '../activity';
import { isParentBusy, type AgentState, type AgentView, type ParentView } from '../roster';
import type { HostPose } from './sceneDefinition';

export type HostAct = { pose: Exclude<HostPose, 'walking' | 'cheering'> } | { pose: 'walking'; target: string };

/** Tools whose `session_id` is a child the parent is checking on, so the host walks over to it. */
const VISIT_TOOLS: ReadonlySet<string> = new Set(['session_read', 'session_send']);
const SETTLED: ReadonlySet<AgentState> = new Set(['done', 'failed', 'paused', 'stopped', 'idle']);

/**
 * What the host is doing, from the parent's live activity: checking on an agent, posting work,
 * combining results once every agent has settled, or idling.
 */
export function hostAct(parent: ParentView, agents: readonly AgentView[]): HostAct {
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

export function hostBubble(parent: ParentView): string | undefined {
  if (parent.status === 'needs-action') return 'Needs you!';
  if (parent.status === 'processing' && parent.activity) return activityLabel(parent.activity);
  return undefined;
}
