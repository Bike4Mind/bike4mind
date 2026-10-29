import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate, search, loopState } = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: { run: undefined as string | undefined },
  loopState: { data: undefined as unknown, isLoading: false },
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
vi.mock('@client/app/components/Loops/LoopActions', () => ({ default: () => null }));
vi.mock('@client/app/components/Loops/LoopTicketBoard', () => ({
  default: ({ onViewRun }: { onViewRun: (id: string) => void }) => (
    <button data-testid="loop-ticket-view-run-link" onClick={() => onViewRun('ticket-run')} />
  ),
}));
vi.mock('@client/app/components/Session/AgentExecution/AgentRunViewer', () => ({
  default: ({ executionId }: { executionId: string }) => <div data-testid="agent-run-viewer">{executionId}</div>,
}));
vi.mock('@client/app/hooks/data/loops', () => ({
  useLoop: () => loopState,
  useLoopTickets: () => ({ data: undefined }),
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
  lastExecutionId: 'last-run',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  search.run = undefined;
  loopState.data = loop();
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
