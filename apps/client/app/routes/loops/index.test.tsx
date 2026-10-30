import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { navigate, loopsState, mutations } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    navigate: vi.fn(),
    loopsState: { data: [] as unknown[], isLoading: false },
    mutations: { update: mutation(), run: mutation(), remove: mutation() },
  };
});

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));
vi.mock('@client/app/components/Agent/AgentPageHeader', () => ({
  default: ({ rightActions }: { rightActions?: React.ReactNode }) => <div>{rightActions}</div>,
}));
vi.mock('@client/app/components/Loops/LoopFormModal', () => ({ default: () => <div data-testid="loop-form-modal" /> }));
vi.mock('@client/app/hooks/data/loops', () => ({
  useLoops: () => loopsState,
  useUpdateLoop: () => mutations.update,
  useRunLoop: () => mutations.run,
  useDeleteLoop: () => mutations.remove,
}));

import LoopsPage from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopsPage />
    </CssVarsProvider>
  );

const loop = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  name: 'Digest',
  goal: 'Summarize',
  model: 'm1',
  sessionId: 's1',
  intervalMinutes: 30,
  tools: [],
  stages: ['todo', 'doing', 'done'],
  status: 'draft',
  memory: { notes: '', nextAction: '' },
  runCount: 3,
  consecutiveFailures: 0,
  creditsUsed: 1234,
  blockedTickets: 0,
  ...overrides,
});

const row = (id = 'l1') => within(screen.getByTestId(`loops-row-${id}`));

beforeEach(() => {
  vi.clearAllMocks();
  loopsState.data = [];
  loopsState.isLoading = false;
});

describe('LoopsPage', () => {
  it('shows the empty state and opens the create form', () => {
    renderPage();
    expect(screen.getByTestId('loops-empty-state')).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId('loops-new-btn')[0]);
    expect(screen.getByTestId('loop-form-modal')).toBeInTheDocument();
  });

  it('shows a draft loop with its schedule, runs, credits and set-live action only', () => {
    loopsState.data = [loop()];
    renderPage();
    const r = row();
    expect(r.getByText('Digest')).toBeInTheDocument();
    expect(r.getByTestId('loop-status-chip')).toHaveTextContent('Draft');
    expect(r.getByText('every 30 min')).toBeInTheDocument();
    expect(r.getByText('never')).toBeInTheDocument();
    expect(r.getByTestId('loops-row-next-run')).toHaveTextContent('-');
    expect(r.getByText('3')).toBeInTheDocument();
    expect(r.getByText('1,234 credits')).toBeInTheDocument();
    expect(r.getByTestId('loop-set-live-btn')).toBeInTheDocument();
    expect(r.queryByTestId('loop-pause-btn')).not.toBeInTheDocument();
    expect(r.queryByTestId('loop-run-now-btn')).not.toBeInTheDocument();
  });

  it('offers pause and run now on a live loop and shows a running loop as running', () => {
    loopsState.data = [loop({ status: 'live', activeExecutionId: 'e1', intervalMinutes: 120 })];
    renderPage();
    const r = row();
    expect(r.getByText('every 2 h')).toBeInTheDocument();
    expect(r.getByTestId('loops-row-next-run')).toHaveTextContent('running');
    expect(r.queryByTestId('loop-set-live-btn')).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('loop-run-now-btn'));
    expect(mutations.run.mutate).toHaveBeenCalledWith('l1');
    fireEvent.click(r.getByTestId('loop-pause-btn'));
    expect(mutations.update.mutate).toHaveBeenCalledWith({ id: 'l1', status: 'paused' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows a past nextRunAt as due', () => {
    loopsState.data = [loop({ status: 'live', nextRunAt: new Date(Date.now() - 60_000).toISOString() })];
    renderPage();
    expect(row().getByTestId('loops-row-next-run')).toHaveTextContent('due');
  });

  it('shows the status reason under the chip', () => {
    loopsState.data = [loop({ status: 'error', statusReason: 'Out of credits' })];
    renderPage();
    expect(row().getByTestId('loop-status-reason')).toHaveTextContent('Out of credits');
    expect(row().getByTestId('loop-set-live-btn')).toBeInTheDocument();
  });

  it('confirms before deleting: cancel keeps the loop, confirm deletes it', () => {
    loopsState.data = [loop()];
    renderPage();
    fireEvent.click(row().getByTestId('loop-delete-btn'));
    fireEvent.click(screen.getByTestId('loop-delete-cancel-btn'));
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(row().getByTestId('loop-delete-btn'));
    fireEvent.click(screen.getByTestId('loop-delete-confirm-btn'));
    expect(mutations.remove.mutate).toHaveBeenCalledWith('l1', expect.anything());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens the loop when its row is clicked', () => {
    loopsState.data = [loop()];
    renderPage();
    fireEvent.click(screen.getByTestId('loops-row-l1'));
    expect(navigate).toHaveBeenCalledWith({ to: '/loops/$id', params: { id: 'l1' } });
  });

  it('opens the loop with Enter on the row, but not with Enter on an action inside it', () => {
    loopsState.data = [loop()];
    renderPage();
    fireEvent.keyDown(row().getByTestId('loop-set-live-btn'), { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('loops-row-l1'), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith({ to: '/loops/$id', params: { id: 'l1' } });
  });

  it('counts and marks the loops that need the owner, but not an owner pause', () => {
    loopsState.data = [
      loop({ id: 'credits', status: 'paused', statusReason: 'Out of credits' }),
      loop({ id: 'blocked', status: 'live', blockedTickets: 2 }),
      loop({ id: 'parked', status: 'needs_you', statusReason: 'Notebook gone' }),
      loop({ id: 'owner', status: 'paused' }),
    ];
    renderPage();
    expect(screen.getByTestId('loops-needs-you-count')).toHaveTextContent('3 loops need you');
    expect(row('credits').getByTestId('loops-row-needs-you')).toHaveTextContent('Needs you');
    expect(row('blocked').getByTestId('loops-row-needs-you')).toHaveTextContent('2 blocked');
    // Its status chip already says "Needs you".
    expect(row('parked').queryByTestId('loops-row-needs-you')).toBeNull();
    expect(row('owner').queryByTestId('loops-row-needs-you')).toBeNull();
  });

  it('hides the count when nothing needs the owner', () => {
    loopsState.data = [loop({ status: 'live' })];
    renderPage();
    expect(screen.queryByTestId('loops-needs-you-count')).toBeNull();
  });
});
