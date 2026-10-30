import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Box,
  Chip,
  CircularProgress,
  DialogTitle,
  Drawer,
  IconButton,
  Link,
  Stack,
  Typography,
} from '@mui/joy';
import AgentPageHeader from '@client/app/components/Agent/AgentPageHeader';
import LoopActions from '@client/app/components/Loops/LoopActions';
import LoopEventLog from '@client/app/components/Loops/LoopEventLog';
import LoopTicketBoard from '@client/app/components/Loops/LoopTicketBoard';
import {
  formatCredits,
  formatInterval,
  formatSpendToday,
  lastRunLabel,
  LoopStatusChip,
  nextRunLabel,
} from '@client/app/components/Loops/loopUi';
import { countNeedsYou, useLoop, useLoopEvents, useLoopTickets } from '@client/app/hooks/data/loops';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import CloseIcon from '@mui/icons-material/Close';
import AgentRunViewer from '@client/app/components/Session/AgentExecution/AgentRunViewer';

export default function LoopDetailPage() {
  const { id = '' } = useParams({ strict: false });
  const navigate = useNavigate();
  // `?run=<executionId>` drives the live run drawer, so it is deep-linkable and Back closes it.
  const { run } = useSearch({ strict: false }) as { run?: string };
  const setRun = (executionId?: string) =>
    navigate({ to: '/loops/$id', params: { id }, search: executionId ? { run: executionId } : {} });
  // Only mounted inside LoopsGate, so the loops API is never called while EnableLoops is off.
  const { data: loop, isLoading, error } = useLoop(id);
  const { data: tickets } = useLoopTickets(id);
  const { data: events } = useLoopEvents(id);
  const needsYou = countNeedsYou(events);
  useDocumentTitle(loop?.name ?? 'Loop');

  if (isLoading) return <CircularProgress size="sm" sx={{ m: 2 }} />;
  if (!loop) {
    const notFound = !error || (isAxiosError(error) && error.response?.status === 404);
    return (
      <Box sx={{ p: 2 }} data-testid="loop-detail-not-found">
        <Typography>{notFound ? 'Loop not found.' : "Couldn't load this loop. Try again shortly."}</Typography>
        <Link component="button" onClick={() => navigate({ to: '/loops' })} data-testid="loop-detail-back-btn">
          Back to loops
        </Link>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <AgentPageHeader
        title={loop.name}
        backTo="/loops"
        rightActions={<LoopActions loop={loop} onDeleted={() => navigate({ to: '/loops' })} />}
      />
      <Stack gap={2} sx={{ p: 2 }}>
        <Stack direction="row" gap={2} alignItems="flex-start" flexWrap="wrap" data-testid="loop-detail-summary">
          <LoopStatusChip loop={loop} />
          {needsYou > 0 && (
            <Chip size="sm" variant="soft" color="warning" data-testid="loop-detail-needs-you">
              {needsYou} need you
            </Chip>
          )}
          <Typography level="body-sm">
            {formatInterval(loop.intervalMinutes)} - last run {lastRunLabel(loop)} - next {nextRunLabel(loop)} -{' '}
            {loop.runCount} runs - {formatCredits(loop.creditsUsed)} (90 days) -{' '}
            <span data-testid="loop-detail-spend-today">{formatSpendToday(loop)} today</span> - {loop.model}
          </Typography>
          {(loop.activeExecutionId ?? loop.lastExecutionId) && (
            <Link
              component="button"
              level="body-sm"
              onClick={() => setRun(loop.activeExecutionId ?? loop.lastExecutionId)}
              data-testid="loop-detail-latest-run-link"
            >
              Latest run
            </Link>
          )}
        </Stack>
        <AccordionGroup variant="outlined" sx={{ borderRadius: 'sm' }}>
          <Accordion>
            <AccordionSummary data-testid="loop-detail-memory-toggle">Memory</AccordionSummary>
            <AccordionDetails>
              <Typography level="title-sm">Next action</Typography>
              <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                {loop.memory.nextAction || '-'}
              </Typography>
              <Typography level="title-sm">Notes</Typography>
              <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
                {loop.memory.notes || '-'}
              </Typography>
            </AccordionDetails>
          </Accordion>
          <Accordion>
            <AccordionSummary data-testid="loop-detail-log-toggle">Log</AccordionSummary>
            <AccordionDetails>
              <LoopEventLog data={events} onViewRun={setRun} />
            </AccordionDetails>
          </Accordion>
        </AccordionGroup>
        <LoopTicketBoard loop={loop} data={tickets} onViewRun={setRun} />
      </Stack>
      <Drawer
        anchor="right"
        open={!!run}
        onClose={() => setRun(undefined)}
        slotProps={{ content: { sx: { width: 'min(720px, 100vw)', p: 2, gap: 1 } } }}
        data-testid="loop-run-drawer"
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <DialogTitle>Run</DialogTitle>
          <IconButton
            size="sm"
            variant="plain"
            aria-label="Close run"
            onClick={() => setRun(undefined)}
            data-testid="loop-run-drawer-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
        <Box sx={{ overflowY: 'auto' }}>{run && <AgentRunViewer executionId={run} />}</Box>
      </Drawer>
    </Box>
  );
}
