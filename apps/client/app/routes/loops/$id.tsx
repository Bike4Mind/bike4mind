import { useNavigate, useParams } from '@tanstack/react-router';
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Box,
  CircularProgress,
  Link,
  Stack,
  Typography,
} from '@mui/joy';
import AgentPageHeader from '@client/app/components/Agent/AgentPageHeader';
import LoopActions from '@client/app/components/Loops/LoopActions';
import LoopTicketBoard from '@client/app/components/Loops/LoopTicketBoard';
import {
  formatCredits,
  formatInterval,
  lastRunLabel,
  LoopStatusChip,
  nextRunLabel,
} from '@client/app/components/Loops/loopUi';
import { useLoop, useLoopTickets } from '@client/app/hooks/data/loops';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { AGENT_TRACE_ROUTE, buildAgentTraceSearch } from '@client/app/utils/agentTraceLink';

export default function LoopDetailPage() {
  const { id = '' } = useParams({ strict: false });
  const navigate = useNavigate();
  // Only mounted inside LoopsGate, so the loops API is never called while EnableLoops is off.
  const { data: loop, isLoading } = useLoop(id, true);
  const { data: tickets } = useLoopTickets(id, true);
  useDocumentTitle(loop?.name ?? 'Loop');

  if (isLoading) return <CircularProgress size="sm" sx={{ m: 2 }} />;
  if (!loop) {
    return (
      <Box sx={{ p: 2 }} data-testid="loop-detail-not-found">
        <Typography>Loop not found.</Typography>
        <Link onClick={() => navigate({ to: '/loops' })}>Back to loops</Link>
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
          <Typography level="body-sm">
            {formatInterval(loop.intervalMinutes)} - last run {lastRunLabel(loop)} - next {nextRunLabel(loop)} -{' '}
            {loop.runCount} runs - {formatCredits(loop.creditsUsed)} (90 days) - {loop.model}
          </Typography>
          {loop.lastExecutionId && (
            <Link
              level="body-sm"
              onClick={() =>
                navigate({
                  to: AGENT_TRACE_ROUTE,
                  search: buildAgentTraceSearch(loop.lastExecutionId!, loop.sessionId),
                })
              }
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
        </AccordionGroup>
        <LoopTicketBoard loop={loop} data={tickets} />
      </Stack>
    </Box>
  );
}
