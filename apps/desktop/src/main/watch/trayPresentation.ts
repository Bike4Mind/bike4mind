import { describeAgentStates, type AgentState } from '@shared/agentState';
import { rootNeedsYou, type WatchOverall, type WatchSnapshot } from '@shared/watch';

export type TrayAction = 'open-tavern' | 'toggle-mini' | 'hide-tray';

export type TrayMenuItem =
  | { kind: 'header'; label: string }
  | { kind: 'approval'; approvalId: string; sessionId: string; rootId: string; label: string; quick: boolean }
  | { kind: 'orchestration'; rootId: string; label: string; agents: { sessionId: string; label: string }[] }
  | { kind: 'separator' }
  | { kind: 'action'; action: TrayAction; label: string };

export interface TrayPresentation {
  icon: WatchOverall;
  /** The words beside the icon (macOS only): set only while someone needs you. */
  title: string;
  tooltip: string;
  items: TrayMenuItem[];
}

/** Long enough to tell two agents apart, short enough that the menu stays narrow. */
export const TRAY_LABEL_MAX = 60;
/** The agent's name before a quick approval's summary, which is never cut (see QUICK_SUMMARY_MAX). */
export const QUICK_AGENT_LABEL_MAX = 24;

// Escapes, not literals: this repo keeps source ASCII. Shapes, not colour, since menus are monochrome.
const STATE_GLYPH: Record<AgentState, string> = {
  'needs-you': '\u25CF',
  working: '\u25D0',
  done: '\u2713',
  failed: '\u2715',
  stopped: '\u25CB',
  idle: '\u25CB',
};

export function truncateLabel(text: string, max = TRAY_LABEL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}\u2026`;
}

export function needsYouTitle(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 needs you' : `${count} need you`;
}

function headline(snapshot: WatchSnapshot): string {
  const states = snapshot.orchestrations.flatMap(orchestration => orchestration.agents.map(agent => agent.state));
  if (snapshot.orchestrations.length === 0) return 'No orchestrations running';
  const parentsNeedingYou = snapshot.orchestrations.reduce(
    (sum, orchestration) => sum + rootNeedsYou(orchestration),
    0
  );
  return describeAgentStates(states, parentsNeedingYou);
}

/** What the menu-bar item shows for a snapshot: pure, so the mapping is tested without Electron. */
export function trayPresentation(snapshot: WatchSnapshot, miniOpen: boolean): TrayPresentation {
  const summary = headline(snapshot);
  const items: TrayMenuItem[] = [{ kind: 'header', label: summary }];

  if (snapshot.pending.length > 0) {
    items.push({ kind: 'separator' });
    for (const pending of snapshot.pending) {
      items.push({
        kind: 'approval',
        approvalId: pending.approvalId,
        sessionId: pending.sessionId,
        rootId: pending.rootId,
        // A quick summary is answered from this row, so only the agent's name may be cut from it.
        label: pending.quick
          ? `${truncateLabel(pending.agentTitle, QUICK_AGENT_LABEL_MAX)}: ${pending.summary}`
          : truncateLabel(`${pending.agentTitle}: ${pending.summary}`),
        quick: pending.quick,
      });
    }
  }

  if (snapshot.orchestrations.length > 0) {
    items.push({ kind: 'separator' });
    for (const orchestration of snapshot.orchestrations) {
      items.push({
        kind: 'orchestration',
        rootId: orchestration.rootId,
        label: truncateLabel(orchestration.title),
        agents: orchestration.agents.map(agent => ({
          sessionId: agent.id,
          label: truncateLabel(
            `${STATE_GLYPH[agent.state]} ${agent.title}${agent.activity ? ` - ${agent.activity}` : ''}`
          ),
        })),
      });
    }
  }

  items.push(
    { kind: 'separator' },
    { kind: 'action', action: 'open-tavern', label: 'Open Tavern' },
    { kind: 'action', action: 'toggle-mini', label: miniOpen ? 'Hide mini Tavern' : 'Show mini Tavern' },
    { kind: 'action', action: 'hide-tray', label: 'Hide menu-bar item' }
  );

  const title = needsYouTitle(snapshot.needsYouCount);
  return { icon: snapshot.overall, title, tooltip: `Bike4Mind - ${title || summary}`, items };
}
