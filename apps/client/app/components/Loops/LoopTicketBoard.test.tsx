import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ILoopTicket, ILoopTicketsResponse } from '@client/app/hooks/data/loops';

const { navigate, moveTicket, createTicket } = vi.hoisted(() => ({
  navigate: vi.fn(),
  moveTicket: { mutate: vi.fn(), isPending: false },
  createTicket: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/hooks/data/loops', () => ({
  useMoveLoopTicket: () => moveTicket,
  useCreateLoopTicket: () => createTicket,
}));

import LoopTicketBoard from './LoopTicketBoard';

const appTheme = extendTheme({ ...getThemeConfig() });

const ticket = (id: string, overrides: Partial<ILoopTicket> = {}): ILoopTicket => ({
  id,
  title: `Ticket ${id}`,
  stage: 'todo',
  status: 'open',
  dependencies: [],
  ready: false,
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...overrides,
});

const loop = { id: 'l1', stages: ['todo', 'doing', 'done'] } as never;

const data: ILoopTicketsResponse = {
  stages: [
    {
      stage: 'todo',
      tickets: [
        ticket('newer', { ready: true, updatedAt: '2026-10-29T12:00:00.000Z' }),
        ticket('older', { ready: true, updatedAt: '2026-10-29T09:00:00.000Z' }),
        ticket('blocked', { status: 'blocked', statusReason: 'Needs an API key', dependencies: ['x', 'y'] }),
      ],
    },
    { stage: 'doing', tickets: [ticket('busy', { stage: 'doing', status: 'in_progress', executionId: 'e1' })] },
    { stage: 'done', tickets: [] },
  ],
};

const renderBoard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopTicketBoard loop={loop} data={data} />
    </CssVarsProvider>
  );

beforeEach(() => vi.clearAllMocks());

describe('LoopTicketBoard', () => {
  it('renders one column per stage in the loop order', () => {
    renderBoard();
    const columns = screen.getAllByTestId(/^loop-stage-column-/).map(el => el.getAttribute('data-testid'));
    expect(columns).toEqual(['loop-stage-column-todo', 'loop-stage-column-doing', 'loop-stage-column-done']);
    expect(
      within(screen.getByTestId('loop-stage-column-todo')).getAllByTestId(/^loop-ticket-(newer|older|blocked)$/)
    ).toHaveLength(3);
  });

  it('summarises queued oldest first, in progress and blocked with reasons', () => {
    renderBoard();
    const queued = screen.getByTestId('loop-ticket-strip-ready');
    expect(queued).toHaveTextContent('Queued (2)');
    expect(queued.textContent!.indexOf('Ticket older')).toBeLessThan(queued.textContent!.indexOf('Ticket newer'));
    expect(screen.getByTestId('loop-ticket-strip-in-progress')).toHaveTextContent('In progress (1)');
    expect(screen.getByTestId('loop-ticket-strip-blocked')).toHaveTextContent('Ticket blocked - Needs an API key');
    expect(
      within(screen.getByTestId('loop-ticket-blocked')).getByTestId('loop-ticket-blocked-reason')
    ).toHaveTextContent('Needs an API key');
    expect(within(screen.getByTestId('loop-ticket-blocked')).getByText('2 deps')).toBeInTheDocument();
  });

  it('links a ticket with a run to its trace', () => {
    renderBoard();
    const link = within(screen.getByTestId('loop-ticket-busy')).getByTestId('loop-ticket-view-run-link');
    expect(link).toHaveAttribute('href', '/agent-executions?expand=e1');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith({ to: '/agent-executions', search: { expand: 'e1' } });
    expect(within(screen.getByTestId('loop-ticket-older')).queryByTestId('loop-ticket-view-run-link')).toBeNull();
  });

  it('moves a ticket with the stage select', () => {
    renderBoard();
    fireEvent.click(within(screen.getByTestId('loop-ticket-older')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'doing' }));
    expect(moveTicket.mutate).toHaveBeenCalledWith({ id: 'older', stage: 'doing' });
  });

  it('adds a ticket in the first stage by default', () => {
    renderBoard();
    fireEvent.click(screen.getByTestId('loop-ticket-add-btn'));
    fireEvent.click(screen.getByTestId('loop-ticket-submit-btn'));
    expect(createTicket.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('loop-ticket-title-input'), { target: { value: ' Write docs ' } });
    fireEvent.click(screen.getByTestId('loop-ticket-submit-btn'));
    expect(createTicket.mutate).toHaveBeenCalledWith(
      { loopId: 'l1', title: 'Write docs', stage: 'todo' },
      expect.anything()
    );
  });
});
