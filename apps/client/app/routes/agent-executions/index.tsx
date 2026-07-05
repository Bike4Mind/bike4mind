/**
 * Agent execution history page (`/agent-executions`).
 *
 * Lists the current user's past agent runs with status, model, cost, and
 * date filters. Each row carries a "Show reasoning" disclosure that
 * lazy-loads the full iteration trace via the same `ReasoningDisclosure`
 * component the chat history uses - so the renderer stays consistent and
 * any iteration-trace improvements land here automatically.
 *
 * Pagination is cursor-based on `createdAt` (the `{ userId, createdAt: -1 }`
 * index makes the range scan cheap). The TTL on the underlying collection is
 * 90 days, surfaced as a footer note so users aren't surprised by older runs
 * disappearing.
 */

import { FC, useCallback, useMemo, useState } from 'react';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/joy';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import { useNavigate } from '@tanstack/react-router';
import { agentExecutionHistoryRoute } from '@client/app/router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import AgentPageHeader from '@client/app/components/Agent/AgentPageHeader';
import { useAgentExecutionsList, type AgentExecutionsListFilters } from '@client/app/hooks/data/agentExecutions';
import HistoryFilters, {
  EMPTY_FILTER_STATE,
  filterStateToQuery,
  type HistoryFilterState,
} from '@client/app/components/AgentExecutionHistory/HistoryFilters';
import ExecutionRow from '@client/app/components/AgentExecutionHistory/ExecutionRow';
import ReasoningDisclosure from '@client/app/components/Session/AgentExecution/ReasoningDisclosure';
import { AGENT_TRACE_ROUTE } from '@client/app/utils/agentTraceLink';

const PAGE_SIZE = 25;

const AgentExecutionHistoryPage: FC = () => {
  useDocumentTitle('Agent Execution History');

  const navigate = useNavigate();
  // Deep-link target from the "View trace" toast launcher. When present, a
  // focused trace panel is shown above the list, hydrated by id - robust to the
  // execution not being on the current (paginated) page, and to background children
  // that never appear in the parent's in-chat nest.
  // Validated search straight from the route's `validateSearch` - no hand-rolled cast.
  const { expand: focusedExecutionId, session: focusedSessionId } = agentExecutionHistoryRoute.useSearch();

  const [filterState, setFilterState] = useState<HistoryFilterState>(EMPTY_FILTER_STATE);

  const queryFilters: AgentExecutionsListFilters = useMemo(
    () => ({ ...filterStateToQuery(filterState), limit: PAGE_SIZE }),
    [filterState]
  );

  const { data, isLoading, isError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } =
    useAgentExecutionsList(queryFilters);

  // Flatten the page chain. `useInfiniteQuery` resets to a single page when
  // the queryKey (filters) changes, so no manual accumulator is needed.
  const items = useMemo(() => data?.pages.flatMap(p => p.items) ?? [], [data]);

  // Memoized so `HistoryFilters`' debounce effect (which lists `onChange` in
  // its deps) doesn't restart the 300ms timer on every parent re-render.
  const handleFiltersChange = useCallback((next: HistoryFilterState) => {
    setFilterState(next);
  }, []);

  // "Are any filters active?" - drives the empty-state copy so a 0-result list
  // doesn't redundantly hint at the 90-day TTL when the user is obviously
  // narrowing the result themselves. Date preset stays distinct from the other
  // filters because `'all'` is the canonical no-op default.
  const hasActiveFilters =
    filterState.statuses.length > 0 ||
    filterState.datePreset !== 'all' ||
    filterState.model.trim() !== '' ||
    filterState.minCredits !== '' ||
    filterState.maxCredits !== '';

  const clearFilters = () => handleFiltersChange(EMPTY_FILTER_STATE);

  return (
    <Box
      data-testid="agent-execution-history-page"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: theme => theme.palette.background.surface2,
        borderRadius: '8px',
        border: '1px solid',
        borderColor: theme => (theme.palette.mode === 'dark' ? 'transparent' : theme.palette.border.muted),
        boxShadow: '2px 2px 20px rgba(0, 0, 0, 0.05)',
        overflowY: 'auto',
        overflowX: 'hidden',
        ...scrollbarStyles,
      }}
    >
      <AgentPageHeader
        title="Agent Execution History"
        backButton={false}
        titleIcon={<HistoryOutlinedIcon sx={{ color: 'text.primary50', width: 24, height: 24 }} />}
      />

      {focusedExecutionId ? (
        <Box
          data-testid="agent-execution-focused-trace"
          sx={{ mx: 2, mt: 2, p: 2, borderRadius: '8px', border: '1px solid', borderColor: 'border.muted' }}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
            <Typography level="title-sm" sx={{ color: 'text.secondary' }}>
              Background run trace
            </Typography>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              data-testid="agent-execution-focused-trace-clear"
              onClick={() => navigate({ to: AGENT_TRACE_ROUTE, search: {} })}
            >
              Back to all
            </Button>
          </Stack>
          <ReasoningDisclosure
            agentExecutionId={focusedExecutionId}
            sessionId={focusedSessionId ?? ''}
            defaultExpanded
            showFinalAnswer
          />
        </Box>
      ) : null}

      <HistoryFilters value={filterState} onChange={handleFiltersChange} />

      <Box
        data-testid="agent-execution-history-list"
        sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1 }}
      >
        {isLoading && items.length === 0 ? (
          <Stack direction="row" justifyContent="center" alignItems="center" sx={{ py: 4 }}>
            <CircularProgress />
          </Stack>
        ) : isError && items.length === 0 ? (
          // First-page failure - full-screen error. A failed *subsequent*
          // page must NOT wipe the already-loaded rows; see the inline error
          // next to the Load-more button below.
          <Stack direction="column" alignItems="center" spacing={1} sx={{ py: 4 }}>
            <Typography level="body-md" sx={{ color: 'danger.softColor' }}>
              Couldn&apos;t load execution history.
            </Typography>
            <Button size="sm" variant="soft" onClick={() => refetch()}>
              Retry
            </Button>
          </Stack>
        ) : items.length === 0 ? (
          <Stack
            direction="column"
            alignItems="center"
            spacing={1}
            sx={{ py: 6, color: 'text.tertiary' }}
            data-testid="agent-execution-history-empty"
          >
            <Typography level="body-md">
              {hasActiveFilters ? 'No agent executions match these filters.' : 'No agent executions yet.'}
            </Typography>
            <Typography level="body-sm">
              {hasActiveFilters
                ? 'Try clearing filters or expanding the date range.'
                : 'Mention an orchestration-enabled agent in chat to kick off your first run.'}
            </Typography>
            {hasActiveFilters ? (
              <Button
                size="sm"
                variant="plain"
                onClick={clearFilters}
                data-testid="agent-execution-history-clear-filters"
              >
                Clear filters
              </Button>
            ) : null}
          </Stack>
        ) : (
          <>
            {items.map(item => (
              <ExecutionRow key={item.id} item={item} />
            ))}
            {hasNextPage ? (
              <Stack direction="column" alignItems="center" spacing={1} sx={{ py: 2 }}>
                {isError ? (
                  // Subsequent-page failure - keep the loaded rows visible,
                  // surface the error inline so Retry refetches the next
                  // page (not the whole list from page 1).
                  <Typography level="body-xs" sx={{ color: 'danger.softColor' }}>
                    Couldn&apos;t load more.
                  </Typography>
                ) : null}
                <Button
                  variant="soft"
                  onClick={() => fetchNextPage()}
                  loading={isFetchingNextPage}
                  data-testid="agent-execution-history-load-more"
                >
                  {isError ? 'Retry' : 'Load more'}
                </Button>
              </Stack>
            ) : (
              // Filter-aware tail copy. Without this, "everything from the
              // last 90 days" is misleading when the user is filtering by
              // status/model/credits - they didn't see *everything*, they saw
              // *everything that matched*.
              <Typography level="body-xs" sx={{ textAlign: 'center', color: 'text.tertiary', py: 2 }}>
                {hasActiveFilters
                  ? "That's everything that matches these filters."
                  : "That's everything from the last 90 days."}
              </Typography>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};

export default AgentExecutionHistoryPage;
