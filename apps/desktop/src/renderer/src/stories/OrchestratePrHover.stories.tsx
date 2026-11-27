import Box from '@mui/joy/Box';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';
import { assignPersonas } from '@shared/agentPersona';
import type { PrBarSnapshot, PrBarState, PrSummary } from '@shared/pullRequest';
import type { OrchestratorViewId } from '../chat/orchestrator/orchestratorViews';
import type { AgentView } from '../chat/orchestrator/roster';
import { renderOrchestratorView } from '../chat/orchestrator/viewRegistry';
import type { Story, StoryDefault } from './ladleTypes';

export default { title: 'Orchestrate PR hover' } satisfies StoryDefault;

/*
 * The agent views with a stubbed PR monitor, so the PR badge's hover card can be tried without a
 * GitHub session. Hover or focus any PR badge.
 */

const AGENTS: { id: string; title: string; pr: PrSummary; snapshot: Partial<PrBarSnapshot> }[] = [
  {
    id: 'a1',
    title: 'Fix the login redirect',
    pr: { number: 8392, state: 'open', attention: 'conflict', repo: 'acme/app' },
    snapshot: {
      title: 'fix(auth): keep the return path through the login redirect',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      reviewDecision: 'REVIEW_REQUIRED',
      checks: [
        { name: 'lint', bucket: 'pass', required: true },
        { name: 'test', bucket: 'pass', required: true },
        { name: 'e2e', bucket: 'pending', required: false },
      ],
    },
  },
  {
    id: 'a2',
    title: 'Add export to CSV',
    pr: { number: 8326, state: 'open', attention: 'changesRequested', behind: true, repo: 'acme/app' },
    snapshot: {
      title: 'feat(reports): export any table to CSV',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      reviewDecision: 'CHANGES_REQUESTED',
      checks: [
        { name: 'lint', bucket: 'pass', required: true },
        { name: 'test', bucket: 'fail', required: true },
      ],
    },
  },
  {
    id: 'a3',
    title: 'Bump the chart library',
    pr: { number: 8310, state: 'merged', repo: 'acme/app' },
    snapshot: {
      title: 'chore(deps): bump the chart library',
      state: 'MERGED',
      mergedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    },
  },
];

function stateOf(sessionId: string): PrBarState | null {
  const agent = AGENTS.find(item => item.id === sessionId);
  if (!agent) return null;
  const snapshot = {
    owner: 'acme',
    repo: 'app',
    number: agent.pr.number,
    url: `https://github.com/acme/app/pull/${agent.pr.number}`,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    checks: [],
    fetchedAt: Date.now() - 2 * 60_000,
    ...agent.snapshot,
  } as PrBarSnapshot;
  return { sessionId, binding: { dismissed: false }, snapshot, gh: 'ok', refreshing: false } as unknown as PrBarState;
}

function stubMonitor() {
  const host = window as unknown as { b4m?: Record<string, unknown> };
  host.b4m = {
    ...host.b4m,
    pullRequests: {
      getState: async (sessionId: string) => stateOf(sessionId),
      onStateChanged: () => () => undefined,
    },
    shell: { openExternal: async () => undefined },
    host: chatBackedHostBridge(),
    chat: {
      getSession: async () => null,
    },
  };
}

const roster: AgentView[] = AGENTS.map(({ id, title, pr }, index) => ({
  id,
  title,
  parentId: 'root',
  depth: 1,
  seedPrompt: title,
  createdAt: '2026-11-24T00:00:00.000Z',
  updatedAt: new Date(Date.now() - index * 600_000).toISOString(),
  model: 'm',
  state: index === 2 ? 'done' : 'working',
  pr,
}));

function View({ view }: { view: OrchestratorViewId }) {
  stubMonitor();
  return (
    <Box sx={{ height: 620, display: 'flex', flexDirection: 'column', pt: 36, pr: 22 }}>
      {renderOrchestratorView(view, {
        agents: roster,
        parent: {},
        rootId: 'root',
        onSelect: () => undefined,
        onOpenPr: () => undefined,
        selectedId: null,
        introPlaying: false,
        personas: assignPersonas(roster),
      })}
    </Box>
  );
}

export const Tavern: Story = () => <View view="tavern" />;
export const Table: Story = () => <View view="table" />;
export const Board: Story = () => <View view="board" />;
