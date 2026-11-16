import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Tab from '@mui/joy/Tab';
import TabList from '@mui/joy/TabList';
import Tabs from '@mui/joy/Tabs';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import type { LocalLoopDetail, LocalLoopSummary } from '@shared/localLoops';
import { ArrowLeftIcon } from '../chat/icons';
import { LoopRunnerSettings, useLoopRunnerState } from '../chat/LoopRunnerSettings';
import { OrchestratorStage, type AgentActions } from '../chat/orchestrator/OrchestratorStage';
import type { OrchestratorViewId } from '../chat/orchestrator/orchestratorPrefs';
import { TableView } from '../chat/orchestrator/TableView';
import { TavernView } from '../chat/orchestrator/tavern/TavernView';
import { LoopBoardView, type TicketMove } from './LoopBoardView';
import { LoopFormModal } from './LoopFormModal';
import { NeedsYouInbox } from './NeedsYouInbox';
import { buildLoopRoster, isLoopSessionId } from './roster';
import { TicketDetail } from './TicketDetail';
import { useLocalLoop, type useLocalLoopList } from './useLocalLoops';

const statusColor = (status: LocalLoopSummary['loop']['status']) =>
  status === 'live' ? 'success' : status === 'error' ? 'danger' : 'neutral';

function LoopRow({
  summary,
  selected,
  onSelect,
}: {
  summary: LocalLoopSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { loop } = summary;
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={event => (event.key === 'Enter' || event.key === ' ') && onSelect()}
      data-testid={`local-loops-row-${loop.id}`}
      sx={{
        p: 1,
        borderRadius: 'sm',
        cursor: 'pointer',
        bgcolor: selected ? 'background.level2' : undefined,
        '&:hover': { bgcolor: 'background.level1' },
      }}
    >
      <Typography level="title-sm" noWrap>
        {loop.name}
      </Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
        <Chip
          size="sm"
          variant="soft"
          color={statusColor(loop.status)}
          data-testid={`local-loops-row-status-${loop.id}`}
        >
          {summary.idleReason ?? loop.status}
        </Chip>
        {summary.needsYou > 0 && (
          <Chip size="sm" variant="solid" color="warning">
            {summary.needsYou} need{summary.needsYou === 1 ? 's' : ''} you
          </Chip>
        )}
      </Stack>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
        {summary.lanesBusy}/{loop.maxConcurrent} lanes - {Math.round(summary.spentToday)}
        {loop.budgetCreditsPerDay !== undefined ? `/${loop.budgetCreditsPerDay}` : ''} credits today - mirror{' '}
        {loop.mirror ? 'on' : 'off'}
      </Typography>
    </Box>
  );
}

/** The all-loops daily budget, shared with web loops; set on the server, cached in main for offline use. */
function AllLoopsBudget() {
  const [cap, setCap] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.b4m.localLoops.getBudget().then(result => {
      if (result.ok) {
        setCap(result.value.dailyCredits);
        setDraft(result.value.dailyCredits === null ? '' : String(result.value.dailyCredits));
      } else setError(result.error);
    });
  }, []);
  const save = async () => {
    setError(null);
    const result = await window.b4m.localLoops.setBudget(draft.trim() ? Number(draft) : null);
    if (result.ok) setCap(result.value.dailyCredits);
    else setError(result.error);
  };
  return (
    <Stack spacing={1} data-testid="local-loops-all-budget">
      <Typography level="body-sm">
        All loops, web and Desktop, stop starting runs once they spend this much in a day.{' '}
        {cap === null ? 'No cap set.' : `Now ${cap} credits.`}
      </Typography>
      <Stack direction="row" spacing={1}>
        <Input
          size="sm"
          type="number"
          placeholder="No cap"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          slotProps={{ input: { 'data-testid': 'local-loops-all-budget-input' } }}
        />
        <Button size="sm" onClick={() => void save()}>
          Save
        </Button>
      </Stack>
      {error && (
        <Typography level="body-xs" color="danger" role="alert">
          {error}
        </Typography>
      )}
    </Stack>
  );
}

/** The machine settings Desktop loops share with the web-loop runner (one lane pool, one LoopPolicyStore). */
function MachinePanel() {
  const [state, setState] = useLoopRunnerState();
  return (
    <Stack spacing={1.5} data-testid="local-loops-machine">
      <Typography level="body-sm">
        Lanes, battery, busy and login settings apply to Desktop loops and to web-loop stages this computer runs. Loops
        run only while this Mac is awake: in System Settings, keep it from sleeping on power if loops should run
        overnight.
      </Typography>
      {state ? (
        <LoopRunnerSettings state={state} onState={setState} />
      ) : (
        <Typography level="body-xs">Loading...</Typography>
      )}
    </Stack>
  );
}

function LoopActivity({ detail }: { detail: LocalLoopDetail }) {
  const titles = new Map(detail.tickets.map(ticket => [ticket.id, ticket.title]));
  return (
    <Stack spacing={0.5} sx={{ p: 1.5, overflowY: 'auto' }} data-testid="local-loops-activity">
      {detail.events.length === 0 && <Typography level="body-sm">Nothing yet.</Typography>}
      {detail.events.map(event => (
        <Typography key={event.id} level="body-xs">
          {new Date(event.createdAt).toLocaleString()} - {event.kind}
          {event.ticketId ? ` (${titles.get(event.ticketId) ?? 'deleted ticket'})` : ''}: {event.reason}
        </Typography>
      ))}
    </Stack>
  );
}

function LoopPane({
  loopId,
  models,
  onOpenSession,
  onDeleted,
}: {
  loopId: string;
  models: readonly ChatModelOption[];
  onOpenSession: (sessionId: string) => void;
  onDeleted: () => void;
}) {
  const { detail, error, clearError, moveTicket, act } = useLocalLoop(loopId);
  const [tab, setTab] = useState<'board' | 'needs-you' | 'activity'>('board');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openTicket, setOpenTicket] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<OrchestratorViewId>('board');
  const api = window.b4m.localLoops;
  if (!detail) return error ? <Alert color="danger">{error}</Alert> : null;
  const { loop } = detail;
  const ticket = openTicket ? detail.tickets.find(entry => entry.id === openTicket) : undefined;

  // Lanes with no session yet (a free lane, a run still opening) have nothing to open or stop.
  const laneActions: AgentActions = {
    open: id => isLoopSessionId(id) && onOpenSession(id),
    // The scheduler sees the stop and ends the run as blocked ("Stopped on the desktop").
    stop: id => isLoopSessionId(id) && void window.b4m.chat.stopReply(id),
    archive: () => undefined,
  };

  const runNow = async () => {
    setNotice(null);
    const next = await act(() => api.runNow(loop.id));
    // A poke that starts nothing leaves the loop idle; say why.
    if (next && next.lanesBusy === 0 && next.idleReason) setNotice(`Not started: ${next.idleReason}`);
  };

  return (
    <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }} data-testid="local-loops-pane">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1.5, pb: 0 }} flexWrap="wrap" useFlexGap>
        <Typography level="title-lg" sx={{ mr: 1 }}>
          {loop.name}
        </Typography>
        <Chip size="sm" variant="soft" color={statusColor(loop.status)} data-testid="local-loops-idle-reason">
          {detail.idleReason ?? `${detail.lanesBusy} running`}
        </Chip>
        <Box sx={{ flex: 1 }} />
        {loop.status === 'live' ? (
          <Button
            size="sm"
            variant="soft"
            onClick={() => void act(() => api.setStatus({ id: loop.id, status: 'paused' }))}
            data-testid="local-loops-pause-btn"
          >
            Pause
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void act(() => api.setStatus({ id: loop.id, status: 'live' }))}
            data-testid="local-loops-resume-btn"
          >
            {loop.status === 'error' ? 'Resume' : 'Set live'}
          </Button>
        )}
        <Button size="sm" variant="soft" onClick={() => void runNow()} data-testid="local-loops-run-now-btn">
          Run now
        </Button>
        <Button size="sm" variant="plain" onClick={() => setEditing(true)} data-testid="local-loops-edit-btn">
          Edit
        </Button>
        {confirmDelete ? (
          <Button
            size="sm"
            color="danger"
            onClick={async () => {
              setConfirmDelete(false);
              if (await act(() => api.deleteLoop(loop.id))) onDeleted();
            }}
            data-testid="local-loops-delete-confirm-btn"
          >
            Delete {loop.name}?
          </Button>
        ) : (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            onClick={() => setConfirmDelete(true)}
            data-testid="local-loops-delete-btn"
          >
            Delete
          </Button>
        )}
      </Stack>
      {(error || notice) && (
        <Alert
          color={error ? 'danger' : 'neutral'}
          role="alert"
          sx={{ mx: 1.5, mt: 1 }}
          data-testid="local-loops-error"
          endDecorator={
            <Button
              size="sm"
              variant="plain"
              onClick={() => {
                clearError();
                setNotice(null);
              }}
            >
              Dismiss
            </Button>
          }
        >
          {error ?? notice}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(_event, value) => setTab(value as typeof tab)}
        sx={{ bgcolor: 'transparent', mt: 1 }}
      >
        <TabList size="sm" sx={{ px: 1.5 }}>
          <Tab value="board" data-testid="local-loops-tab-board">
            Board
          </Tab>
          <Tab value="needs-you" data-testid="local-loops-tab-needs-you">
            Needs you{detail.needsYou > 0 ? ` (${detail.needsYou})` : ''}
          </Tab>
          <Tab value="activity" data-testid="local-loops-tab-activity">
            Activity
          </Tab>
        </TabList>
      </Tabs>
      {tab === 'board' && (
        <OrchestratorStage
          agents={buildLoopRoster(detail)}
          view={view}
          onViewChange={setView}
          introPlaying={false}
          actions={laneActions}
          renderView={(id, props) => {
            if (id === 'tavern') return <TavernView {...props} />;
            if (id === 'table') return <TableView {...props} />;
            return (
              <LoopBoardView
                detail={detail}
                onMove={(ticketId, move) => void moveTicket(ticketId, move)}
                onCreate={async title => !!(await act(() => api.createTicket({ loopId: loop.id, title })))}
                onDelete={ticketId => void act(() => api.updateTicket({ id: ticketId, delete: true }))}
                onOpen={setOpenTicket}
              />
            );
          }}
        />
      )}
      {tab === 'needs-you' && (
        <NeedsYouInbox
          detail={detail}
          onAnswer={request => void act(() => api.answerEvent(request))}
          onReopen={id => void moveTicket(id, { status: 'open' })}
          onResume={() => void act(() => api.setStatus({ id: loop.id, status: 'live' }))}
        />
      )}
      {tab === 'activity' && <LoopActivity detail={detail} />}
      {editing && (
        <LoopFormModal
          loop={loop}
          models={models}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
      {ticket && (
        <TicketDetail
          ticket={ticket}
          detail={detail}
          onSave={(move: TicketMove) => moveTicket(ticket.id, move)}
          onOpenSession={onOpenSession}
          onClose={() => setOpenTicket(null)}
        />
      )}
    </Stack>
  );
}

/**
 * Loops owned by this Desktop (main/loops/local): list, board, needs-you inbox and activity, with every action the
 * web Loops page has for its loops except Slack, coaching and stats. Web loops stay on the web.
 */
export function LoopsScreen({
  list: { summaries, error },
  models,
  onClose,
  onOpenSession,
}: {
  /** ChatShell's subscription (it also feeds the sidebar badge), so the list is not fetched twice. */
  list: Pick<ReturnType<typeof useLocalLoopList>, 'summaries' | 'error'>;
  models: readonly ChatModelOption[];
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [panel, setPanel] = useState<'budget' | 'machine' | null>(null);
  const selectedId = summaries.some(summary => summary.loop.id === selected)
    ? selected
    : (summaries[0]?.loop.id ?? null);

  return (
    <Stack direction="row" sx={{ flex: 1, minWidth: 0, minHeight: 0 }} data-testid="loops-screen">
      <Stack sx={{ width: 260, flexShrink: 0, borderRight: '1px solid', borderColor: 'divider', p: 1, gap: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <IconButton size="sm" variant="plain" onClick={onClose} aria-label="Back to chat">
            <ArrowLeftIcon />
          </IconButton>
          <Typography level="title-md" sx={{ flex: 1 }}>
            Loops
          </Typography>
          <Button size="sm" onClick={() => setCreating(true)} data-testid="local-loops-new-btn">
            New loop
          </Button>
        </Stack>
        {error && (
          <Alert color="danger" data-testid="local-loops-list-error">
            {error}
          </Alert>
        )}
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {summaries.length === 0 && !error && (
            <Typography level="body-sm" sx={{ p: 1 }} data-testid="local-loops-empty">
              No loops yet. A loop works a board of tickets on this Mac, one run per ticket, while you do other things.
            </Typography>
          )}
          {summaries.map(summary => (
            <LoopRow
              key={summary.loop.id}
              summary={summary}
              selected={summary.loop.id === selectedId}
              onSelect={() => setSelected(summary.loop.id)}
            />
          ))}
        </Box>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setPanel('budget')}
          data-testid="local-loops-budget-btn"
        >
          All-loops budget
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setPanel('machine')}
          data-testid="local-loops-machine-btn"
        >
          Machine
        </Button>
      </Stack>
      {selectedId && (
        <LoopPane
          key={selectedId}
          loopId={selectedId}
          models={models}
          onOpenSession={onOpenSession}
          onDeleted={() => setSelected(null)}
        />
      )}
      {creating && (
        <LoopFormModal
          models={models}
          onClose={() => setCreating(false)}
          onSaved={loopId => {
            setCreating(false);
            setSelected(loopId);
          }}
        />
      )}
      {panel && (
        <Modal open onClose={() => setPanel(null)}>
          <ModalDialog sx={{ width: 520, maxWidth: '95vw', overflowY: 'auto' }}>
            <ModalClose />
            <Typography level="title-md">{panel === 'budget' ? 'All-loops budget' : 'Machine'}</Typography>
            {panel === 'budget' ? <AllLoopsBudget /> : <MachinePanel />}
          </ModalDialog>
        </Modal>
      )}
    </Stack>
  );
}
