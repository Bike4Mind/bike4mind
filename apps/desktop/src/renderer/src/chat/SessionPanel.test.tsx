// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject, ProjectInspection } from '@shared/chat';
import type { PrBarState } from '@shared/pullRequest';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { desktopTheme } from '../theme';
import { SessionPanel, type SessionPanelProps } from './SessionPanel';
import { useSessionPanelPrefs } from './sessionPanelState';
import type { ProjectBindingController } from './useChat';
import type { BackgroundProcessView } from './useBackgroundProcesses';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// CssVarsProvider reads the colour scheme through it.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const PROJECT: ChatProject = {
  directory: '/Users/someone/code/thing',
  name: 'thing',
  branch: 'main',
  workspace: false,
  workingDirectory: '/Users/someone/code/thing',
  contextDirectories: [],
};

const CHANGES: WorkspaceChanges = {
  base: 'origin/main',
  added: 53,
  removed: 1,
  fileCount: 1,
  files: [{ path: 'src/a.ts', added: 53, removed: 1 }],
  commitsAhead: 0,
  uncommitted: 1,
};

const PULL_REQUEST: PrBarState = {
  sessionId: 'session-1',
  binding: {
    owner: 'example-org',
    repo: 'widgets',
    number: 611,
    url: 'https://github.com/example-org/widgets/pull/611',
    source: 'shell',
    boundAt: '',
  },
  snapshot: {
    owner: 'example-org',
    repo: 'widgets',
    number: 611,
    url: 'https://github.com/example-org/widgets/pull/611',
    title: 'feat: ladder',
    author: 'octo-dev',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/widget-ladder',
    headSha: 'sha-1',
    baseRefName: 'main',
    baseSha: 'base-1',
    additions: 103,
    deletions: 16,
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
  autoFix: { status: 'off', attempts: 0, max: 5 },
};

const binding: ProjectBindingController = {
  busy: false,
  error: null,
  dismissError: vi.fn(),
  pickDirectory: vi.fn(),
  chooseDirectory: vi.fn(),
  setBranch: vi.fn(),
  setWorkspace: vi.fn(),
  moveToCheckout: vi.fn(),
  worktreeFrom: vi.fn(),
  addContextDirectory: vi.fn(),
  removeContextDirectory: vi.fn(),
};

const process = (id: string, status: BackgroundProcessView['status']): BackgroundProcessView =>
  ({
    id,
    command: `pnpm run ${id}`,
    status,
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    ...(status === 'running' ? {} : { endedAt: new Date().toISOString(), exitCode: 0 }),
    output: '',
  }) as BackgroundProcessView;

type Overrides = {
  [K in keyof SessionPanelProps]?: SessionPanelProps[K] extends object
    ? Partial<SessionPanelProps[K]>
    : SessionPanelProps[K];
};

function props(overrides: Overrides = {}): Omit<SessionPanelProps, 'collapsed' | 'onToggleSection'> {
  return {
    variant: overrides.variant ?? 'docked',
    ...(overrides.onDismiss ? { onDismiss: overrides.onDismiss } : {}),
    environment: {
      project: PROJECT,
      binding,
      settledTurns: 0,
      inUse: false,
      preparing: false,
      ...overrides.environment,
    },
    changes: {
      workspace: null,
      hasPullRequest: false,
      pullRequest: null,
      pullRequestActions: {
        onDismiss: async () => ({ ok: true }),
        onRefresh: () => {},
        onSetOption: async () => ({ ok: true }),
      },
      busy: false,
      onCreatePullRequest: () => {},
      ...overrides.changes,
    },
    context: { contextTokens: null, contextLimit: null, credits: null, ...overrides.context },
    plan: { todos: null, turnOpen: false, ...overrides.plan },
    background: {
      processes: [],
      spawned: [],
      onStopProcess: () => {},
      onStopSession: () => {},
      onOpenSession: () => {},
      onShowOutput: () => {},
      ...overrides.background,
    },
  };
}

/** The panel with its real persisted prefs, as ChatShell wires it. */
function Harness(rest: Omit<SessionPanelProps, 'collapsed' | 'onToggleSection'>) {
  const prefs = useSessionPanelPrefs();
  return <SessionPanel {...rest} collapsed={prefs.collapsed} onToggleSection={prefs.toggleSection} />;
}

let host: HTMLDivElement;
let root: Root;

async function show(overrides: Overrides = {}): Promise<void> {
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <Harness {...props(overrides)} />
      </CssVarsProvider>
    )
  );
  await act(async () => undefined);
}

const find = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const get = (testId: string) => {
  const found = find(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};
const sectionIds = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid^="session-panel-section-"]')].map(section =>
    section.dataset.testid?.replace('session-panel-section-', '')
  );

beforeEach(() => {
  window.localStorage.clear();
  const inspection: ProjectInspection = {
    directory: PROJECT.directory,
    name: 'thing',
    isRepository: true,
    branches: ['main'],
    currentBranch: 'main',
  };
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { inspectProject: async () => inspection, listRecentFolders: async () => [] },
    getAppInfo: async () => ({ homeDirectory: '' }),
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('SessionPanel sections', () => {
  it('draws only Environment, with the chips in their panel layout, when nothing else has content', async () => {
    await show();
    expect(sectionIds()).toEqual(['environment']);
    expect(find('session-chips-panel')).not.toBeNull();
    expect(get('session-chip-branch-btn').textContent).toBe('main');
  });

  it('draws every section in order once each has something to say', async () => {
    await show({
      context: { contextTokens: 1_000, contextLimit: 200_000 },
      changes: { workspace: CHANGES },
      plan: { todos: [{ content: 'Do it', status: 'pending' }], turnOpen: true },
      background: { processes: [process('dev', 'running')] },
    });
    expect(sectionIds()).toEqual(['environment', 'context', 'changes', 'plan', 'background']);
  });
});

describe('the Changes / Pull request section', () => {
  it('with no PR, shows the working-directory changes and sends Create PR to the same handler', async () => {
    const onCreatePullRequest = vi.fn();
    await show({ changes: { workspace: CHANGES, onCreatePullRequest } });

    expect(get('session-panel-changes-toggle-btn').textContent).toContain('Changes');
    expect(find('changes-bar')).not.toBeNull();
    expect(find('pr-bar')).toBeNull();

    await act(async () => get('changes-bar-create-pr-btn').click());
    expect(onCreatePullRequest).toHaveBeenCalledWith(CHANGES);
  });

  it('keeps the totals and Create PR on screen with the section folded', async () => {
    await show({ changes: { workspace: CHANGES } });
    await act(async () => get('session-panel-changes-toggle-btn').click());

    expect(get('session-panel-changes-toggle-btn').getAttribute('aria-expanded')).toBe('false');
    expect(find('changes-bar')).toBeNull();
    expect(get('session-panel-changes-summary').textContent).toBe('+53 -1');
    expect(find('changes-bar-create-pr-btn')).not.toBeNull();
  });

  it('with a PR, shows it instead - its number, state and diff - and offers no second PR', async () => {
    await show({ changes: { workspace: CHANGES, hasPullRequest: true, pullRequest: PULL_REQUEST } });

    expect(get('session-panel-changes-toggle-btn').textContent).toContain('Pull request');
    expect(find('pr-bar')).not.toBeNull();
    expect(find('pr-bar-open-icon')).not.toBeNull();
    expect(get('pr-bar-diff').textContent).toBe('+103 -16');
    expect(find('changes-bar')).toBeNull();
    expect(find('changes-bar-create-pr-btn')).toBeNull();

    await act(async () => get('session-panel-changes-toggle-btn').click());
    expect(get('pr-bar-headline').textContent).toContain('#611');
    expect(get('pr-bar-headline-diff').textContent).toBe('+103 -16');
  });

  it('leaves the section out for a PR whose bar was dismissed, rather than offering another', async () => {
    await show({ changes: { workspace: CHANGES, hasPullRequest: true, pullRequest: null } });
    expect(sectionIds()).toEqual(['environment']);
  });
});

describe('the Context section', () => {
  it('is left out until a request has been measured', async () => {
    await show({ context: { contextTokens: null, contextLimit: 200_000 } });
    expect(sectionIds()).not.toContain('context');
  });

  it('shows the share of the window with a bar, and folds to the percentage', async () => {
    await show({ context: { contextTokens: 50_000, contextLimit: 200_000 } });
    expect(sectionIds()).toEqual(['environment', 'context']);
    expect(get('session-panel-context-bar').getAttribute('aria-valuetext')).toBe('25%');
    expect(get('session-panel-context-figure').textContent).toContain('(25%)');

    await act(async () => get('session-panel-context-toggle-btn').click());
    expect(find('session-panel-context-bar')).toBeNull();
    expect(get('session-panel-context-toggle-btn').textContent).toContain('25%');
  });

  it('gives the token count and no bar when the model states no window', async () => {
    await show({ context: { contextTokens: 50_000, contextLimit: null } });
    expect(find('session-panel-context-bar')).toBeNull();
    expect(get('session-panel-context-figure').textContent).toContain('reports no window size');
  });
});

describe('the Plan section', () => {
  const todos = [
    { content: 'Read the code', status: 'completed' as const },
    { content: 'Write the fix', status: 'in_progress' as const },
    { content: 'Run the tests', status: 'pending' as const },
  ];

  it('lists the items, and folds to the progress count', async () => {
    await show({ plan: { todos, turnOpen: true } });
    expect(host.querySelectorAll('[data-testid^="chat-todo-item-"]')).toHaveLength(3);

    await act(async () => get('session-panel-plan-toggle-btn').click());
    expect(find('chat-todo-item-pending')).toBeNull();
    expect(get('session-panel-plan-toggle-btn').textContent).toContain('1/3');
  });

  it('is left out once the plan is finished and no turn is running', async () => {
    await show({ plan: { todos: todos.map(todo => ({ ...todo, status: 'completed' as const })), turnOpen: false } });
    expect(sectionIds()).not.toContain('plan');
  });
});

describe('the Background tasks section', () => {
  it('lists running commands and spawned sessions with a stop each, and folds the finished ones', async () => {
    const onStopProcess = vi.fn();
    const onStopSession = vi.fn();
    const onOpenSession = vi.fn();
    const onShowOutput = vi.fn();
    await show({
      background: {
        processes: [process('dev', 'running'), process('build', 'exited')],
        spawned: [
          { id: 'child', title: 'Write the docs', createdAt: new Date().toISOString(), status: 'processing' },
          { id: 'done-child', title: 'Old task', createdAt: new Date().toISOString(), status: 'done' },
        ],
        onStopProcess,
        onStopSession,
        onOpenSession,
        onShowOutput,
      },
    });

    expect(get('session-panel-task-running').textContent).toContain('pnpm run dev');
    expect(get('session-panel-task-running').textContent).toMatch(/1m [56]s/);
    const stops = host.querySelectorAll<HTMLElement>('[data-testid="session-panel-task-stop-btn"]');
    expect(stops).toHaveLength(2);
    await act(async () => stops[0].click());
    expect(onStopProcess).toHaveBeenCalledWith('dev');
    await act(async () => stops[1].click());
    expect(onStopSession).toHaveBeenCalledWith('child');

    await act(async () => get('session-panel-spawned-open-btn').click());
    expect(onOpenSession).toHaveBeenCalledWith('child');

    const finished = get('session-panel-finished-toggle-btn');
    expect(finished.textContent).toContain('Finished 2');
    expect(finished.getAttribute('aria-expanded')).toBe('false');
    expect(find('session-panel-task-finished')).toBeNull();
    await act(async () => finished.click());
    expect(get('session-panel-task-finished').textContent).toContain('exit 0');
    expect(find('session-panel-spawned-finished')).not.toBeNull();

    await act(async () => get('session-panel-show-output-btn').click());
    expect(onShowOutput).toHaveBeenCalled();

    await act(async () => get('session-panel-background-toggle-btn').click());
    expect(get('session-panel-background-toggle-btn').textContent).toContain('2 running');
  });
});

describe('section headers', () => {
  it('are buttons that say whether they are open and which body they control', async () => {
    await show();
    const toggle = get('session-panel-environment-toggle-btn');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBe(
      get('session-panel-environment-body')
    );
  });

  it('remember which sections are folded across a remount', async () => {
    await show();
    await act(async () => get('session-panel-environment-toggle-btn').click());
    expect(window.localStorage.getItem('b4m.sessionPanel.collapsed')).toBe('["environment"]');

    act(() => root.unmount());
    root = createRoot(host);
    await show();
    expect(get('session-panel-environment-toggle-btn').getAttribute('aria-expanded')).toBe('false');
    expect(find('session-panel-environment-body')).toBeNull();
  });
});

describe('the popover variant', () => {
  it('shuts on Escape or a press outside it, and not on a press inside', async () => {
    const onDismiss = vi.fn();
    await show({ variant: 'popover', onDismiss });
    expect(get('session-panel').dataset.variant).toBe('popover');

    await act(async () =>
      get('session-panel-environment-toggle-btn').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    );
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('ignores Escape and outside presses while docked', async () => {
    const onDismiss = vi.fn();
    await show({ variant: 'docked', onDismiss });
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
