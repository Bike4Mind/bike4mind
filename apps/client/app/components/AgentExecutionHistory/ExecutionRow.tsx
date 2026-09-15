/**
 * Single row of the execution history list. Renders a summary header (status,
 * model, iteration count, credits, time, query preview) plus the reasoning
 * disclosure that lazy-loads the full iteration trace when expanded.
 *
 * Reuses `ReasoningDisclosure` directly - that component already handles
 * fetching + Zustand hydration + mounting `IterationStream`, and it's the
 * canonical "read-only trace viewer" elsewhere in the app. Sharing it here
 * keeps the trace rendering consistent and means improvements to the disclosure
 * (subagent nesting, performance) land in the history viewer for free.
 */

import { FC } from 'react';
import { Box, Card, Stack, Typography } from '@mui/joy';
import { Link as RouterLink } from '@tanstack/react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import type { AgentExecutionListItem } from '@client/app/hooks/data/agentExecutions';
import ReasoningDisclosure from '@client/app/components/Session/AgentExecution/ReasoningDisclosure';
import StatusChip from './StatusChip';

dayjs.extend(relativeTime);

interface ExecutionRowProps {
  item: AgentExecutionListItem;
}

const ExecutionRow: FC<ExecutionRowProps> = ({ item }) => {
  const credits = item.totalCreditsUsed.toLocaleString();
  const iterations = item.totalIterations != null ? `${item.totalIterations} iters` : '—';
  const created = dayjs(item.createdAt);
  const elapsed =
    item.completedAt && item.startedAt ? dayjs(item.completedAt).diff(dayjs(item.startedAt), 'second') : null;

  return (
    <Card
      variant="outlined"
      data-testid={`execution-row-${item.id}`}
      sx={{
        '--Card-padding': theme => theme.spacing(2),
        backgroundColor: 'background.surface',
      }}
    >
      <Stack direction="column" spacing={1}>
        <Stack direction="row" alignItems="center" flexWrap="wrap" spacing={1} rowGap={0.5} sx={{ minWidth: 0 }}>
          <StatusChip status={item.status} />
          {item.isBackgroundExecution ? (
            <Typography level="body-xs" sx={{ color: 'primary.softColor' }}>
              · background
            </Typography>
          ) : null}
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            {item.model}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            · {iterations}
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            · {credits} credits
          </Typography>
          {elapsed != null ? (
            <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
              · {elapsed}s
            </Typography>
          ) : null}
          <Box sx={{ flex: 1 }} />
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }} title={created.format()}>
            {created.fromNow()}
          </Typography>
        </Stack>

        <Typography
          level="body-md"
          sx={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            overflow: 'hidden',
          }}
        >
          {item.query}
        </Typography>

        {item.errorMessage ? (
          <Typography level="body-sm" sx={{ color: 'danger.softColor' }}>
            {item.errorMessage}
          </Typography>
        ) : null}

        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <ReasoningDisclosure agentExecutionId={item.id} sessionId={item.sessionId} />
          <RouterLink
            to="/notebooks/$id"
            params={{ id: item.sessionId }}
            style={{ color: 'var(--joy-palette-primary-plainColor)', fontSize: '0.875rem', textDecoration: 'none' }}
            data-testid={`execution-row-${item.id}-open-session`}
          >
            Open chat →
          </RouterLink>
        </Stack>
      </Stack>
    </Card>
  );
};

export default ExecutionRow;
