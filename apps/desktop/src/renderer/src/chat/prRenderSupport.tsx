import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrBarState, PrDisplayState, PrState, PrSummary } from '@shared/pullRequest';
import { PrStatusBar } from './PrStatusBar';
import { SessionList } from './SessionList';

/** Test-only: the bar and a one-row sidebar rendered to markup, for the PR colour tests. */

export const STATES: { display: PrDisplayState; state: PrState; isDraft: boolean }[] = [
  { display: 'open', state: 'OPEN', isDraft: false },
  { display: 'draft', state: 'OPEN', isDraft: true },
  { display: 'merged', state: 'MERGED', isDraft: false },
  { display: 'closed', state: 'CLOSED', isDraft: false },
];

const URL = 'https://github.com/example-org/widgets/pull/611';

function barState(state: PrState, isDraft: boolean): PrBarState {
  return {
    sessionId: 'session-1',
    binding: { owner: 'example-org', repo: 'widgets', number: 611, url: URL, source: 'shell', boundAt: '' },
    snapshot: {
      owner: 'example-org',
      repo: 'widgets',
      number: 611,
      url: URL,
      title: 'feat: ladder',
      author: 'octo-dev',
      state,
      isDraft,
      headRefName: 'feat/widget-ladder',
      headSha: 'sha-1',
      baseRefName: 'main',
      additions: 1,
      deletions: 0,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      autoMergeArmed: false,
      checks: [],
      repoSettings: { autoMergeAllowed: false, allowedMethods: ['squash'] },
      viewer: 'octo-dev',
      fetchedAt: 0,
    },
    gh: 'ok',
    refreshing: false,
    autoMerge: { mode: null },
    autoFix: { status: 'off', attempts: 0, max: 3 },
  };
}

// The fields the sidebar reads; the rest of a summary is irrelevant to a row's marker.
const SESSION = { id: 'session-1', title: 'Ladder', mode: 'code', messageCount: 1 } as ChatSessionSummary;

export function renderBar(mode: 'light' | 'dark', state: PrState, isDraft: boolean): string {
  return renderToStaticMarkup(
    <CssVarsProvider defaultMode={mode}>
      <PrStatusBar
        state={barState(state, isDraft)}
        onDismiss={async () => ({ ok: true })}
        onRefresh={() => {}}
        onSetOption={async () => ({ ok: true })}
      />
    </CssVarsProvider>
  );
}

export function renderSidebar(
  pr: PrSummary | undefined,
  status: ChatSessionStatus = 'done',
  mode: 'light' | 'dark' = 'light'
): string {
  return renderToStaticMarkup(
    <CssVarsProvider defaultMode={mode}>
      <SessionList
        sessions={[SESSION]}
        mode="code"
        onModeChange={() => {}}
        loading={false}
        activeId={null}
        statuses={new Map(status === 'done' ? [] : [[SESSION.id, status]])}
        prSummaries={new Map(pr ? [[SESSION.id, pr]] : [])}
        collapsed={false}
        onToggleCollapsed={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenArtifacts={() => {}}
        onCreateInProject={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
        onToggleArchived={() => {}}
      />
    </CssVarsProvider>
  );
}
