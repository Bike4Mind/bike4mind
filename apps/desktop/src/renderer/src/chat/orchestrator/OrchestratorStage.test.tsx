// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../../theme';
import { OrchestratorStage } from './OrchestratorStage';
import type { AgentState, AgentView } from './roster';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const agent = (id: string, state: AgentState, extra: Partial<AgentView> = {}): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: `seed ${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
  usdCost: 1,
  ...extra,
});

const FIXTURE = [
  agent('n', 'needs-you'),
  agent('w1', 'working'),
  agent('w2', 'working'),
  agent('d', 'done', { usdCost: undefined }),
];

let root: Root | null = null;
let host: HTMLElement | null = null;
const onViewChange = vi.fn();
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };

function mount(agents: AgentView[], dockControl?: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <OrchestratorStage
          agents={agents}
          view="table"
          onViewChange={onViewChange}
          actions={actions}
          introPlaying={false}
          dockControl={dockControl}
        />
      </CssVarsProvider>
    );
  });
}

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { getSession: vi.fn().mockResolvedValue(null) },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe('OrchestratorStage', () => {
  it('summarises the roster, with ~ when a cost is unknown', () => {
    mount(FIXTURE);
    expect(query('orchestrator-summary-strip')?.textContent).toBe(
      '4 agents \u00B7 2 working \u00B7 1 need you \u00B7 1 done \u00B7 0 failed \u00B7 ~$3.00'
    );
  });

  it('hides the needs-you pill when nothing needs the user', () => {
    mount([agent('w', 'working')]);
    expect(query('orchestrator-needs-you-pill')).toBeNull();
  });

  it('opens the drawer for the first needs-you agent from the pill and closes on Escape', async () => {
    mount(FIXTURE);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => query('orchestrator-needs-you-pill')?.click());
    expect(query('orchestrator-peek-drawer')?.textContent).toContain('Agent n');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(query('orchestrator-peek-drawer')).toBeNull();
  });

  it('opens the drawer when a table row is clicked', async () => {
    mount(FIXTURE);
    await act(async () => query('orchestrator-table-row-w2')?.click());
    expect(query('orchestrator-peek-drawer')?.textContent).toContain('Agent w2');
  });

  it('reports a view change', () => {
    mount(FIXTURE);
    act(() => query('orchestrator-view-tab-board')?.click());
    expect(onViewChange).toHaveBeenCalledWith('board');
  });

  it('renders the dock control in the header', () => {
    mount(FIXTURE, <span data-testid="dock-probe" />);
    expect(query('dock-probe')).not.toBeNull();
  });
});
