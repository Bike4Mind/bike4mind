import { describe, expect, it } from 'vitest';
import type { ChildOutcome } from '@shared/agentOutcome';
import { countAgentStates, describeAgentStates } from '@shared/agentState';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { WorkerTask } from '@shared/orchestration';
import { needsYouCount } from '@shared/needsYou';
import { buildWatchSnapshot } from '@shared/watch';
import { needsYouTitle, trayPresentation } from '../../../../main/watch/trayPresentation';
import { miniStripLabel } from '../../watch/MiniStrip';
import { agentStates, buildRoster, summarizeRoster } from './roster';

const AT = '2026-11-14T10:00:00.000Z';

function session(
  id: string,
  parentId: string | null,
  extra: { lastOutcome?: ChildOutcome; task?: WorkerTask['state'] } = {}
): ChatSessionSummary {
  return {
    id,
    title: `Agent ${id}`,
    createdAt: AT,
    updatedAt: AT,
    messageCount: 1,
    model: 'test-model',
    ...(parentId ? { origin: { parentSessionId: parentId, seedPrompt: 'go' } } : {}),
    ...(extra.lastOutcome && { lastOutcome: extra.lastOutcome }),
    ...(extra.task && { workerTask: { state: extra.task } as WorkerTask }),
  } as ChatSessionSummary;
}

// One of every state, plus task records waiting on the user's decision, which count as "needs you".
const sessions = [
  session('root', null),
  session('working', 'root'),
  session('asking', 'root'),
  session('finished', 'root', { lastOutcome: 'finished' }),
  session('accepted', 'root', {
    lastOutcome: 'finished',
    task: { status: 'completed', accepted: true } as WorkerTask['state'],
  }),
  session('unreviewed', 'root', {
    lastOutcome: 'finished',
    task: { status: 'completed', accepted: false } as WorkerTask['state'],
  }),
  session('blocked', 'root', { lastOutcome: 'finished', task: { status: 'blocked' } as WorkerTask['state'] }),
  session('failed', 'root', { lastOutcome: 'failed' }),
  session('aborted', 'root', { lastOutcome: 'aborted' }),
  session('idle', 'root', { lastOutcome: 'no-reply' }),
  session('nested', 'working', { lastOutcome: 'finished' }),
];
const statuses = new Map<string, ChatSessionStatus>([
  ['root', 'needs-action'],
  ['working', 'processing'],
  ['asking', 'needs-action'],
]);

describe('agent counts across surfaces', () => {
  it('agree for the same orchestration on the Tavern, the stage strip, the toggle, the menu bar and the mini Tavern', () => {
    const roster = buildRoster({ sessions, statuses, activity: new Map(), prSummaries: new Map(), rootId: 'root' });
    const parent = { status: statuses.get('root') };
    const stage = summarizeRoster(roster, parent).counts;
    const tavern = describeAgentStates(
      roster.map(agent => agent.state),
      1
    );
    const toggle = countAgentStates(agentStates(sessions, statuses, 'root'), 1);

    const snapshot = buildWatchSnapshot({
      sessions,
      statuses,
      activity: new Map(),
      pending: new Map(),
      needsYouSince: new Map(),
      unacknowledgedDone: new Set(),
      now: Date.parse(AT),
    });
    const tray = trayPresentation(snapshot, false);
    const header = tray.items[0];
    const watched = countAgentStates(
      snapshot.orchestrations[0].agents.map(agent => agent.state),
      1
    );

    expect(stage).toEqual({ total: 10, 'needs-you': 4, working: 1, done: 3, failed: 1, stopped: 1, idle: 1 });
    expect(toggle).toEqual(stage);
    expect(watched).toEqual(stage);
    expect(tavern).toBe('10 agents: 4 need you, 1 working, 1 failed, 1 stopped, 1 idle, 3 done');
    expect(header).toEqual({ kind: 'header', label: tavern });
    expect(miniStripLabel(snapshot.orchestrations[0])).toBe(`Agent root: ${tavern}`);
    // The menu-bar title and the dock badge count by the same rule as every "needs you" above.
    expect(snapshot.needsYouCount).toBe(stage['needs-you']);
    expect(needsYouCount(statuses, sessions)).toBe(stage['needs-you']);
    expect(tray.title).toBe(needsYouTitle(stage['needs-you']));
  });
});
