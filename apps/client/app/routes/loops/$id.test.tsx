import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate, search, loopState, actions, eventsState, loopsState, overrideDirective } = vi.hoisted(() => ({
  navigate: vi.fn(),
  loopsState: { data: [] as unknown[] },
  overrideDirective: { mutate: vi.fn() },
  eventsState: { data: undefined as unknown },
  search: { run: undefined as string | undefined },
  loopState: { data: undefined as unknown, isLoading: false, error: null as unknown },
  actions: { onDeleted: undefined as (() => void) | undefined },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: 'l1' }),
  useSearch: () => search,
}));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));
vi.mock('@client/app/components/Agent/AgentPageHeader', () => ({
  default: ({ rightActions }: { rightActions?: React.ReactNode }) => <div>{rightActions}</div>,
}));
vi.mock('@client/app/components/Loops/LoopActions', () => ({
  default: ({ onDeleted }: { onDeleted?: () => void }) => {
    actions.onDeleted = onDeleted;
    return null;
  },
}));
vi.mock('@client/app/components/Loops/LoopTicketBoard', () => ({
  default: ({ onViewRun }: { onViewRun: (id: string) => void }) => (
    <button data-testid="loop-ticket-view-run-link" onClick={() => onViewRun('ticket-run')} />
  ),
}));
vi.mock('@client/app/components/Session/AgentExecution/AgentRunViewer', () => ({
  default: ({ executionId }: { executionId: string }) => <div data-testid="agent-run-viewer">{executionId}</div>,
}));
vi.mock('@client/app/hooks/data/loops', async importOriginal => ({
  countNeedsYou: (await importOriginal<typeof import('@client/app/hooks/data/loops')>()).countNeedsYou,
  useLoop: () => loopState,
  useLoopTickets: () => ({ data: undefined }),
  useLoopEvents: () => eventsState,
  useLoops: () => loopsState,
  useOverrideDirective: () => overrideDirective,
}));

import LoopDetailPage from './$id';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopDetailPage />
    </CssVarsProvider>
  );

const loop = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  name: 'Digest',
  model: 'm1',
  sessionId: 's1',
  intervalMinutes: 30,
  stages: ['todo', 'done'],
  status: 'live',
  memory: { notes: '', nextAction: '' },
  runCount: 2,
  creditsUsed: 0,
  creditsToday: 0,
  lastExecutionId: 'last-run',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  search.run = undefined;
  loopState.data = loop();
  loopState.error = null;
  eventsState.data = undefined;
  loopsState.data = [];
});

describe('LoopDetailPage states', () => {
  it('shows spend today against the budget', () => {
    loopState.data = loop({ creditsToday: 5, budgetCreditsPerDay: 10 });
    renderPage();
    expect(screen.getByTestId('loop-detail-spend-today')).toHaveTextContent('5 / 10 credits today');
  });

  it('says not found on a 404 and links back to the list', () => {
    loopState.data = undefined;
    loopState.error = Object.assign(new Error('nope'), { isAxiosError: true, response: { status: 404 } });
    renderPage();
    expect(screen.getByTestId('loop-detail-not-found')).toHaveTextContent('Loop not found.');
    fireEvent.click(screen.getByTestId('loop-detail-back-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/loops' });
  });

  it('does not call a failed load "not found"', () => {
    loopState.data = undefined;
    loopState.error = Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500 } });
    renderPage();
    expect(screen.getByTestId('loop-detail-not-found')).toHaveTextContent("Couldn't load this loop.");
  });

  it('returns to the list after the loop is deleted', () => {
    renderPage();
    actions.onDeleted?.();
    expect(navigate).toHaveBeenCalledWith({ to: '/loops' });
  });
});

describe('LoopDetailPage run drawer', () => {
  it('opens a ticket run in the drawer via ?run=', () => {
    renderPage();
    expect(screen.queryByTestId('agent-run-viewer')).toBeNull();
    fireEvent.click(screen.getByTestId('loop-ticket-view-run-link'));
    expect(navigate).toHaveBeenCalledWith({ to: '/loops/$id', params: { id: 'l1' }, search: { run: 'ticket-run' } });
  });

  it('opens the active run from "Latest run", falling back to the last one', () => {
    loopState.data = loop({ activeExecutionId: 'active-run' });
    const { unmount } = renderPage();
    fireEvent.click(screen.getByTestId('loop-detail-latest-run-link'));
    expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ search: { run: 'active-run' } }));
    unmount();

    loopState.data = loop();
    renderPage();
    fireEvent.click(screen.getByTestId('loop-detail-latest-run-link'));
    expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ search: { run: 'last-run' } }));
  });

  it('renders the viewer for ?run= and clears the param on close', () => {
    search.run = 'ticket-run';
    renderPage();
    expect(screen.getByTestId('loop-run-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('agent-run-viewer')).toHaveTextContent('ticket-run');
    fireEvent.click(screen.getByTestId('loop-run-drawer-close-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/loops/$id', params: { id: 'l1' }, search: {} });
  });
});

describe('LoopDetailPage log', () => {
  const unsure = (id: string, resolution?: unknown) => ({
    id,
    kind: 'unsure',
    executionId: `run-${id}`,
    iteration: 1,
    confidence: 0.3,
    reason: 'thin',
    createdAt: '2026-10-29T10:00:00.000Z',
    ...(resolution ? { resolution } : {}),
  });

  it('counts the unsure runs that need the owner', () => {
    renderPage();
    expect(screen.queryByTestId('loop-detail-needs-you')).toBeNull();

    eventsState.data = [unsure('a'), unsure('b'), unsure('c', { outcome: 'resumed', at: '2026-10-29T11:00:00.000Z' })];
    renderPage();
    expect(screen.getByTestId('loop-detail-needs-you')).toHaveTextContent('2 need you');
  });

  it('opens a logged run in the drawer', () => {
    eventsState.data = [unsure('a')];
    renderPage();
    fireEvent.click(screen.getByTestId('loop-log-view-run-btn'));
    expect(navigate).toHaveBeenCalledWith({ to: '/loops/$id', params: { id: 'l1' }, search: { run: 'run-a' } });
  });
});

describe('LoopDetailPage oversight', () => {
  it('links the loops this one oversees and the loops overseeing it', () => {
    loopState.data = loop({ oversees: ['w1'] });
    loopsState.data = [
      { id: 'l1', name: 'Self', oversees: ['w1'] },
      { id: 'w1', name: 'Closer' },
      { id: 'o1', name: 'Lead', oversees: ['l1'] },
      { id: 'x1', name: 'Unrelated' },
    ];
    renderPage();
    const line = screen.getByTestId('loop-detail-oversight');
    expect(line.textContent).toBe('Oversees: CloserOverseen by: Lead');
    fireEvent.click(screen.getByRole('button', { name: 'Lead' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/loops/$id', params: { id: 'o1' } });
  });

  it('shows nothing for a loop outside any oversight', () => {
    renderPage();
    expect(screen.queryByTestId('loop-detail-oversight')).toBeNull();
  });

  it('wires the log override to the mutation', () => {
    eventsState.data = [
      {
        id: 'd1',
        kind: 'directive',
        loopId: 'l1',
        fromLoopId: 'o1',
        fromLoopName: 'Lead',
        executionId: 'x',
        instruction: 'Do X',
        reason: 'Y',
        state: 'open',
        replies: [],
        createdAt: '2026-10-29T10:00:00.000Z',
      },
    ];
    renderPage();
    fireEvent.click(screen.getByTestId('loop-log-directive-withdraw-btn'));
    fireEvent.click(screen.getByTestId('loop-log-directive-confirm-btn'));
    expect(overrideDirective.mutate).toHaveBeenCalledWith({ loopId: 'l1', eventId: 'd1', action: 'withdraw' });
  });
});
