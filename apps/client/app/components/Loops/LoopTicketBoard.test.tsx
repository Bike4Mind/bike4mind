import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ILoopTicket, ILoopTicketsResponse } from '@client/app/hooks/data/loops';

const { onViewRun, moveTicket, createTicket, handoffTicket, rateTicket, savingIds } = vi.hoisted(() => ({
  onViewRun: vi.fn(),
  rateTicket: { mutate: vi.fn(), isPending: false },
  handoffTicket: { mutate: vi.fn(), isPending: false },
  moveTicket: { mutate: vi.fn(), isPending: false },
  createTicket: { mutate: vi.fn(), isPending: false },
  // Ticket ids whose move is still saving, as useMutationState would select them.
  savingIds: [] as string[],
}));

vi.mock('@client/app/hooks/data/loops', () => ({
  MOVE_LOOP_TICKET_KEY: ['loops', 'move'],
  useMoveLoopTicket: () => moveTicket,
  useCreateLoopTicket: () => createTicket,
  useHandoffLoopTicket: () => handoffTicket,
  useRateLoopTicket: () => rateTicket,
  useLoops: () => ({
    data: [
      { id: 'l1', name: 'Builder', stages: ['todo', 'doing', 'done'] },
      { id: 'l2', name: 'Reviewer', stages: ['queue', 'review', 'merged'] },
    ],
  }),
}));
vi.mock('@tanstack/react-query', () => ({ useMutationState: () => savingIds }));

import LoopTicketBoard from './LoopTicketBoard';

const appTheme = extendTheme({ ...getThemeConfig() });

const ticket = (id: string, overrides: Partial<ILoopTicket> = {}): ILoopTicket => ({
  id,
  title: `Ticket ${id}`,
  stage: 'todo',
  status: 'open',
  dependencies: [],
  runCount: 0,
  priority: 'p2',
  demoted: false,
  epic: false,
  stale: false,
  ready: false,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...overrides,
});

const loop = { id: 'l1', stages: ['todo', 'doing', 'done'] } as never;

const data: ILoopTicketsResponse = {
  stages: [
    {
      stage: 'todo',
      tickets: [
        ticket('newer', { ready: true, createdAt: '2026-10-29T12:00:00.000Z' }),
        ticket('older', { ready: true, createdAt: '2026-10-29T09:00:00.000Z', updatedAt: '2026-10-29T13:00:00.000Z' }),
        ticket('blocked', { status: 'blocked', statusReason: 'Needs an API key', dependencies: ['x', 'y'] }),
      ],
    },
    { stage: 'doing', tickets: [ticket('busy', { stage: 'doing', status: 'in_progress', executionId: 'e1' })] },
    { stage: 'done', tickets: [] },
  ],
  runLimit: 6,
};

const renderBoard = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <LoopTicketBoard loop={loop} data={data} onViewRun={onViewRun} />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  savingIds.length = 0;
});

describe('LoopTicketBoard', () => {
  it('shows the rating only on closed tickets; a thumb rates, the active one clears, a note saves on Enter', () => {
    const closed = (id: string, extra: Partial<ILoopTicket> = {}) =>
      ticket(id, { stage: 'done', status: 'closed', ...extra });
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard
          loop={loop}
          data={{
            ...data,
            stages: [
              ...data.stages.slice(0, 2),
              {
                stage: 'done',
                tickets: [closed('c1'), closed('c2', { ownerRating: { value: 'up', note: 'ok', at: '' } })],
              },
            ],
          }}
          onViewRun={onViewRun}
        />
      </CssVarsProvider>
    );
    expect(within(screen.getByTestId('loop-ticket-newer')).queryByTestId('loop-ticket-rating-up-btn')).toBeNull();

    fireEvent.click(within(screen.getByTestId('loop-ticket-c1')).getByTestId('loop-ticket-rating-down-btn'));
    expect(rateTicket.mutate).toHaveBeenLastCalledWith({ loopId: 'l1', ticketId: 'c1', value: 'down' });

    const rated = screen.getByTestId('loop-ticket-c2');
    expect(within(rated).getByTestId('loop-ticket-rating-up-btn')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(rated).getByTestId('loop-ticket-rating-up-btn'));
    expect(rateTicket.mutate).toHaveBeenLastCalledWith({ loopId: 'l1', ticketId: 'c2', value: null });

    const note = within(rated).getByTestId('loop-ticket-rating-note-input');
    expect(note).toHaveValue('ok');
    fireEvent.change(note, { target: { value: ' great ' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(rateTicket.mutate).toHaveBeenLastCalledWith({ loopId: 'l1', ticketId: 'c2', value: 'up', note: 'great' });
  });

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

  it('queues a ticket further along first, and shows how many runs a ticket has used', () => {
    const later: ILoopTicketsResponse = {
      stages: [
        { stage: 'todo', tickets: [ticket('first', { ready: true, runCount: 2 })] },
        {
          stage: 'doing',
          tickets: [ticket('along', { stage: 'doing', ready: true, createdAt: '2026-10-29T12:00:00.000Z' })],
        },
      ],
      runLimit: 6,
    };
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard loop={loop} data={later} onViewRun={onViewRun} />
      </CssVarsProvider>
    );
    const queued = screen.getByTestId('loop-ticket-strip-ready').textContent!;
    expect(queued.indexOf('Ticket along')).toBeLessThan(queued.indexOf('Ticket first'));
    expect(within(screen.getByTestId('loop-ticket-first')).getByTestId('loop-ticket-run-count')).toHaveTextContent(
      'Run 2 of 6'
    );
    expect(within(screen.getByTestId('loop-ticket-along')).queryByTestId('loop-ticket-run-count')).toBeNull();
  });

  it('opens the run of a ticket that has one', () => {
    renderBoard();
    fireEvent.click(within(screen.getByTestId('loop-ticket-busy')).getByTestId('loop-ticket-view-run-link'));
    expect(onViewRun).toHaveBeenCalledWith('e1');
    expect(within(screen.getByTestId('loop-ticket-older')).queryByTestId('loop-ticket-view-run-link')).toBeNull();
  });

  it('moves a ticket with the stage select', () => {
    renderBoard();
    const card = within(screen.getByTestId('loop-ticket-older'));
    fireEvent.click(within(card.getByTestId('loop-ticket-stage-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'doing' }));
    expect(moveTicket.mutate).toHaveBeenCalledWith({ loopId: 'l1', id: 'older', stage: 'doing' });
  });

  it('locks only the card whose move is saving', () => {
    savingIds.push('older');
    renderBoard();
    const disabled = (id: string, testId: string) =>
      within(within(screen.getByTestId(`loop-ticket-${id}`)).getByTestId(testId))
        .getByRole('combobox')
        .hasAttribute('disabled');
    expect(disabled('older', 'loop-ticket-stage-select')).toBe(true);
    expect(disabled('older', 'loop-ticket-priority-select')).toBe(true);
    expect(disabled('newer', 'loop-ticket-stage-select')).toBe(false);
    expect(disabled('newer', 'loop-ticket-priority-select')).toBe(false);
    // A ticket a run is working stays locked as before.
    expect(disabled('busy', 'loop-ticket-stage-select')).toBe(true);
  });

  const renderDesktopBoard = (runner?: ILoopTicketsResponse['runner']) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard
          loop={
            {
              id: 'l1',
              stages: ['todo', 'doing', 'done'],
              stageConfig: [{ stage: 'doing', runner: 'desktop' }],
            } as never
          }
          data={{
            stages: [
              { stage: 'todo', tickets: [ticket('cloud')] },
              {
                stage: 'doing',
                tickets: [
                  ticket('waiting', { stage: 'doing' }),
                  ticket('busy', { stage: 'doing', status: 'in_progress' }),
                ],
              },
              { stage: 'done', tickets: [] },
            ],
            runLimit: 6,
            runner,
          }}
          onViewRun={onViewRun}
        />
      </CssVarsProvider>
    );

  it('marks a desktop stage and its open tickets as waiting for a desktop runner', () => {
    renderDesktopBoard({ online: false, lanesFree: 0 });
    expect(screen.getByTestId('loop-board-stage-desktop-doing')).toBeInTheDocument();
    expect(screen.queryByTestId('loop-board-stage-desktop-todo')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('loop-ticket-waiting')).getByTestId('loop-ticket-waiting-desktop')
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('loop-ticket-busy')).queryByTestId('loop-ticket-waiting-desktop')).toBeNull();
    expect(within(screen.getByTestId('loop-ticket-cloud')).queryByTestId('loop-ticket-waiting-desktop')).toBeNull();
  });

  it('says whether the desktop runner is offline or has the ticket queued', () => {
    const { unmount } = renderDesktopBoard({ online: false, lanesFree: 0 });
    expect(screen.getByTestId('loop-ticket-waiting-desktop')).toHaveTextContent('Waiting on: desktop offline');
    unmount();

    renderDesktopBoard({ online: true, lanesFree: 0, waitingReason: 'All lanes busy' });
    const chip = screen.getByTestId('loop-ticket-waiting-desktop');
    expect(chip).toHaveTextContent('Queued for desktop');
    expect(chip).toHaveAttribute('title', 'All lanes busy');
  });

  it('labels a ticket left in a removed stage instead of showing an empty select', () => {
    const orphan: ILoopTicketsResponse = {
      stages: [{ stage: 'todo', tickets: [ticket('o', { stage: 'review' })] }],
      runLimit: 6,
    };
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard loop={loop} data={orphan} onViewRun={onViewRun} />
      </CssVarsProvider>
    );
    const card = within(screen.getByTestId('loop-ticket-o'));
    fireEvent.click(within(card.getByTestId('loop-ticket-stage-select')).getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'review (removed)' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('adds a ticket in the first stage by default', () => {
    renderBoard();
    fireEvent.click(screen.getByTestId('loop-ticket-add-btn'));
    fireEvent.click(screen.getByTestId('loop-ticket-submit-btn'));
    expect(createTicket.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('loop-ticket-title-input'), { target: { value: ' Write docs ' } });
    fireEvent.click(screen.getByTestId('loop-ticket-submit-btn'));
    // Triage by default: no priority, so the loop's triage run sets one.
    expect(createTicket.mutate).toHaveBeenCalledWith(
      { loopId: 'l1', title: 'Write docs', stage: 'todo' },
      expect.anything()
    );
  });

  it('marks untriaged, demoted, overdue and epic tickets, and sorts untriaged ones last', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard
          loop={{ ...(loop as object), serviceLevelHours: { p0: 2 } } as never}
          data={{
            stages: [
              {
                stage: 'todo',
                tickets: [
                  ticket('fresh', { priority: undefined, createdAt: '2026-10-29T08:00:00.000Z' }),
                  ticket('lowered', { priority: 'p3', demoted: true }),
                  ticket('late', { priority: 'p0', stale: true }),
                  ticket('big', {
                    priority: undefined,
                    status: 'blocked',
                    blockedOn: 'dependencies',
                    epic: true,
                    dependencies: ['a', 'b', 'c'],
                    childrenDone: 1,
                  }),
                ],
              },
            ],
            runLimit: 6,
          }}
          onViewRun={onViewRun}
        />
      </CssVarsProvider>
    );
    const card = (id: string) => within(screen.getByTestId(`loop-ticket-${id}`));
    expect(card('fresh').getByTestId('loop-ticket-untriaged')).toBeInTheDocument();
    expect(card('fresh').queryByTestId('loop-ticket-priority-chip')).toBeNull();
    expect(card('fresh').getByTestId('loop-ticket-priority-select')).toHaveTextContent('Triage');
    expect(card('lowered').getByTestId('loop-ticket-demoted')).toBeInTheDocument();
    expect(card('late').queryByTestId('loop-ticket-demoted')).toBeNull();
    expect(card('late').getByTestId('loop-ticket-stale')).toHaveAttribute('title', 'Waiting past its 2h service level');
    expect(card('big').getByTestId('loop-ticket-epic')).toHaveTextContent('Epic: 1/3 children done');
    expect(card('big').queryByTestId('loop-ticket-untriaged')).toBeNull();
    expect(card('big').queryByTestId('loop-ticket-waiting-deps')).toBeNull();
    const order = within(screen.getByTestId('loop-stage-column-todo'))
      .getAllByTestId(/^loop-ticket-(fresh|lowered|late|big)$/)
      .map(el => el.getAttribute('data-testid'));
    expect(order.indexOf('loop-ticket-fresh')).toBeGreaterThan(order.indexOf('loop-ticket-lowered'));
  });

  const renderTickets = (stages: ILoopTicketsResponse['stages']) =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard loop={loop} data={{ stages, runLimit: 6 }} onViewRun={onViewRun} />
      </CssVarsProvider>
    );

  it('shows a priority chip on each card and changes priority with its select', () => {
    renderBoard();
    expect(screen.getAllByTestId('loop-ticket-priority-chip')).toHaveLength(4);
    const card = within(screen.getByTestId('loop-ticket-older'));
    expect(card.getByTestId('loop-ticket-priority-chip')).toHaveTextContent('P2');
    fireEvent.click(within(card.getByTestId('loop-ticket-priority-select')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'P0' }));
    expect(moveTicket.mutate).toHaveBeenCalledWith({ loopId: 'l1', id: 'older', priority: 'p0' });
  });

  it('adds a ticket with the chosen priority', () => {
    renderBoard();
    fireEvent.click(screen.getByTestId('loop-ticket-add-btn'));
    fireEvent.change(screen.getByTestId('loop-ticket-title-input'), { target: { value: 'Hotfix' } });
    fireEvent.click(within(screen.getByTestId('loop-ticket-priority-select-new')).getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'P0' }));
    fireEvent.click(screen.getByTestId('loop-ticket-submit-btn'));
    expect(createTicket.mutate).toHaveBeenCalledWith(
      { loopId: 'l1', title: 'Hotfix', stage: 'todo', priority: 'p0' },
      expect.anything()
    );
  });

  it('orders open cards and the Queued strip by priority first, then age; closed cards stay last', () => {
    renderTickets([
      {
        stage: 'todo',
        tickets: [
          ticket('old-p2', { ready: true, createdAt: '2026-10-29T08:00:00.000Z' }),
          ticket('new-p2', { ready: true, createdAt: '2026-10-29T09:00:00.000Z' }),
          ticket('new-p0', { ready: true, priority: 'p0', createdAt: '2026-10-29T12:00:00.000Z' }),
        ],
      },
      {
        stage: 'doing',
        tickets: [ticket('along-p3', { stage: 'doing', ready: true, priority: 'p3' })],
      },
      {
        stage: 'done',
        tickets: [
          ticket('closed-p3', { stage: 'done', status: 'closed', priority: 'p3' }),
          ticket('open-p0', { stage: 'done', priority: 'p0' }),
        ],
      },
    ]);
    const ids = (stage: string) =>
      within(screen.getByTestId(`loop-stage-column-${stage}`))
        .getAllByTestId(/^loop-ticket-[a-z0-9]+-p\d$/)
        .map(el => el.getAttribute('data-testid'));
    expect(ids('todo')).toEqual(['loop-ticket-new-p0', 'loop-ticket-old-p2', 'loop-ticket-new-p2']);
    expect(ids('done')).toEqual(['loop-ticket-open-p0', 'loop-ticket-closed-p3']);

    const queued = screen.getByTestId('loop-ticket-strip-ready').textContent!;
    const at = (id: string) => queued.indexOf(`Ticket ${id}`);
    expect(at('new-p0')).toBeLessThan(at('old-p2'));
    expect(at('old-p2')).toBeLessThan(at('new-p2'));
    expect(at('new-p2')).toBeLessThan(at('along-p3'));
  });

  it('shows a ticket parked on its dependencies as waiting, not as a blocked reason', () => {
    renderTickets([
      {
        stage: 'todo',
        tickets: [
          ticket('parked', {
            status: 'blocked',
            blockedOn: 'dependencies',
            statusReason: 'Waiting on dependencies',
            dependencies: ['x'],
          }),
        ],
      },
    ]);
    const card = within(screen.getByTestId('loop-ticket-parked'));
    expect(card.getByTestId('loop-ticket-waiting-deps')).toHaveTextContent('Waiting on dependencies');
    expect(card.queryByTestId('loop-ticket-blocked-reason')).toBeNull();
  });

  it('renders a blocked reason as markdown on the card', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard
          loop={loop}
          data={{
            stages: [
              {
                stage: 'todo',
                tickets: [ticket('b', { status: 'blocked', statusReason: 'Unsure: pick **one**\n\n- EU\n- US' })],
              },
            ],
          }}
          onViewRun={onViewRun}
        />
      </CssVarsProvider>
    );
    const reason = screen.getByTestId('loop-ticket-blocked-reason');
    expect(reason.querySelector('strong')).toHaveTextContent('one');
    expect(reason.querySelectorAll('li')).toHaveLength(2);
    expect(reason.textContent).not.toContain('**');
  });

  it('offers a hand-off only on tickets a run is not working, and sends the picked loop, stage and note', () => {
    renderBoard();
    expect(within(screen.getByTestId('loop-ticket-busy')).queryByTestId('loop-ticket-handoff-btn')).toBeNull();
    fireEvent.click(within(screen.getByTestId('loop-ticket-older')).getByTestId('loop-ticket-handoff-btn'));
    expect(screen.getByTestId('loop-ticket-handoff-confirm-btn')).toBeDisabled();
    fireEvent.click(within(screen.getByTestId('loop-ticket-handoff-loop-select')).getByRole('combobox'));
    expect(screen.queryByRole('option', { name: 'Builder' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Reviewer' }));
    fireEvent.click(within(screen.getByTestId('loop-ticket-handoff-stage-select')).getByRole('combobox'));
    expect(screen.queryByRole('option', { name: 'merged' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'review' }));
    fireEvent.change(screen.getByTestId('loop-ticket-handoff-note-input'), { target: { value: ' ready ' } });
    fireEvent.click(screen.getByTestId('loop-ticket-handoff-confirm-btn'));
    expect(handoffTicket.mutate).toHaveBeenCalledWith(
      { loopId: 'l1', id: 'older', toLoopId: 'l2', stage: 'review', note: 'ready' },
      expect.anything()
    );
  });

  it('shows where a ticket came from and where copies went', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <LoopTicketBoard
          loop={loop}
          data={{
            stages: [{ stage: 'todo', tickets: [ticket('t', { from: 'Builder', handedTo: ['Docs', 'Review'] })] }],
          }}
          onViewRun={onViewRun}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('loop-ticket-origin-chip')).toHaveTextContent('From Builder');
    expect(screen.getByTestId('loop-ticket-handed-to-chip')).toHaveTextContent('Handed to Docs, Review');
  });
});
