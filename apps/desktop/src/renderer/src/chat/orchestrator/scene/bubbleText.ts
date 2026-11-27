import { SESSION_SETUP_LABEL } from '@shared/chat';
import { activityLabel } from '../activity';
import type { AgentView } from '../roster';

const BUBBLE_MAX = 28;

export const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}\u2026` : text);

/** The line over a sprite's head; `needsYou` is how many waiting agents its bubble speaks for (0: none). */
export function bubbleText(agent: AgentView, needsYou: number): string | undefined {
  if (agent.state === 'needs-you') {
    if (needsYou === 0) return undefined;
    return needsYou === 1 ? 'Needs you!' : `Needs you! \u00d7${needsYou}`;
  }
  if (agent.state === 'working' && agent.preparing) return `${SESSION_SETUP_LABEL[agent.preparing]}\u2026`;
  if (agent.state === 'working' && agent.activity) return truncate(activityLabel(agent.activity), BUBBLE_MAX);
  if (agent.state === 'waiting' && agent.background) return truncate(waitingLabel(agent.background), BUBBLE_MAX);
  if (agent.state === 'paused')
    return truncate(agent.lastSnippet ? `Paused: ${agent.lastSnippet}` : 'Paused: turn budget', BUBBLE_MAX);
  // A plain agent's Done only means its turn ended; what it last said (a question, "blocked: ...") is
  // the part the user needs. A worker task's Done is an accepted result, so it stays quiet.
  if (agent.state === 'done' && !agent.workerTask && agent.lastSnippet) return truncate(agent.lastSnippet, BUBBLE_MAX);
  if (agent.state === 'idle' && agent.lastSnippet) return truncate(agent.lastSnippet, BUBBLE_MAX);
  return undefined;
}

/** The host's own line, cut to the same width as an agent's. */
export const hostBubbleText = (text: string) => truncate(text, BUBBLE_MAX);

/** "Waiting: pnpm test" for one background job, "Waiting: 3 jobs" for several. */
export function waitingLabel(jobs: { running: number; label: string }): string {
  return jobs.running === 1 ? `Waiting: ${jobs.label}` : `Waiting: ${jobs.running} jobs`;
}
