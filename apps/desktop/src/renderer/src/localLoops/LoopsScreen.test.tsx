// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalLoopDetail } from '@shared/localLoops';
import { desktopTheme } from '../theme';
import { LoopsScreen } from './LoopsScreen';

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

const detail: LocalLoopDetail = {
  loop: {
    id: 'l1',
    name: 'Docs',
    goal: '',
    stages: ['todo'],
    stageConfig: [],
    model: 'loop-model',
    maxConcurrent: 2,
    status: 'live',
    directory: '/repo',
    approvalMode: 'auto',
    mirror: true,
    memory: { notes: '', nextAction: '' },
    errorStreak: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  lanesBusy: 1,
  spentToday: 0,
  needsYou: 0,
  tickets: [
    {
      id: 't1',
      loopId: 'l1',
      title: 'Fix the docs',
      stage: 'todo',
      status: 'in_progress',
      dependencies: [],
      runCount: 1,
      stageHistory: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  runs: [
    {
      id: 'r1',
      loopId: 'l1',
      ticketId: 't1',
      kind: 'ticket',
      sessionId: 's1',
      model: 'run-model',
      fallback: false,
      startedAt: '2026-01-02T00:00:00.000Z',
      credits: 3,
    },
  ],
  events: [],
};

const api = {
  get: vi.fn(async () => ({ ok: true, value: detail })),
  onChanged: vi.fn(() => () => undefined),
};
let root: Root;
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(window, { b4m: { localLoops: api, chat: { getSession: vi.fn(async () => null) } } });
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <LoopsScreen
          list={{ summaries: [detail], error: null }}
          models={[]}
          onClose={() => undefined}
          onOpenSession={() => undefined}
        />
      </CssVarsProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

it('shows the ticket board by default, on the orchestrator stage', () => {
  expect(byTestId('orchestrator-stage')).not.toBeNull();
  expect(byTestId('orchestrator-view-menu-btn')!.dataset.view).toBe('board');
  expect(byTestId('local-loops-card-t1')).not.toBeNull();
});

it('lists the lanes as rows in the Table view: the running run and the free lane', async () => {
  await act(async () => byTestId('orchestrator-view-menu-btn')!.click());
  await act(async () => byTestId('orchestrator-view-option-table')!.click());
  expect(byTestId('orchestrator-table-row-s1')).not.toBeNull();
  expect(byTestId('orchestrator-table-row-lane:l1:2')).not.toBeNull();
  expect(byTestId('local-loops-card-t1')).toBeNull();
});
