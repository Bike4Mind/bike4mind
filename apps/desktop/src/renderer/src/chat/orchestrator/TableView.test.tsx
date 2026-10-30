// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../../theme';
import type { AgentView } from './roster';
import { TableView } from './TableView';

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

const agent = (id: string, extra: Partial<AgentView> = {}): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: `seed ${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state: 'working',
  ...extra,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const onSelect = vi.fn();

function mount(agents: AgentView[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <TableView agents={agents} onSelect={onSelect} selectedId={null} introPlaying={false} />
      </CssVarsProvider>
    );
  });
}

const rowIds = () =>
  Array.from(document.querySelectorAll('[data-testid^="orchestrator-table-row-"]')).map(row =>
    row.getAttribute('data-testid')?.replace('orchestrator-table-row-', '')
  );

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe('TableView', () => {
  const agents = [
    agent('a', { usdCost: 0.5 }),
    agent('b', { usdCost: 2 }),
    agent('c', { usdCost: 1, pr: { number: 7, state: 'open' } }),
  ];

  it('renders a row per agent in roster order', () => {
    mount(agents);
    expect(rowIds()).toEqual(['a', 'b', 'c']);
    expect(document.body.textContent).toContain('#7 open');
  });

  it('sorts by cost, priciest first, then reverses', () => {
    mount(agents);
    const header = document.querySelector<HTMLElement>('[data-testid="orchestrator-table-sort-cost"]');
    act(() => header?.click());
    expect(rowIds()).toEqual(['b', 'c', 'a']);
    act(() => header?.click());
    expect(rowIds()).toEqual(['a', 'c', 'b']);
  });

  it('calls onSelect with the row id and indents deeper agents', () => {
    mount([agent('a'), agent('b', { depth: 3 })]);
    act(() => document.querySelector<HTMLElement>('[data-testid="orchestrator-table-row-b"]')?.click());
    expect(onSelect).toHaveBeenCalledWith('b');
    const title = document.querySelector(
      '[data-testid="orchestrator-table-row-b"] td:nth-child(2) p, [data-testid="orchestrator-table-row-b"] td:nth-child(2) > *'
    );
    expect(getComputedStyle(title as Element).paddingLeft).toBe('32px');
  });

  it('shows the activity while working and the last snippet otherwise', () => {
    mount([
      agent('a', { activity: { kind: 'phase', phase: 'thinking' } }),
      agent('b', { state: 'done', lastSnippet: 'All shipped' }),
      agent('c', { state: 'idle' }),
    ]);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Thinking');
    expect(text).toContain('All shipped');
  });
});
