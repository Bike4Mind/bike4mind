import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  FormLabel,
  Input,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import { toast } from 'sonner';
import {
  useCleanupAgentExecutions,
  useStuckAgentExecutions,
  type StuckExecutionItem,
} from '@client/app/hooks/data/stuckAgentExecutions';
import { ACTIVE_AGENT_EXECUTION_STATUSES, type AgentExecutionStatus } from '@client/app/stores/useAgentExecutionStore';

// Both `awaiting_subagent` and `awaiting_dag_children` are excluded: healthy
// parents in either state idle while children work, so they're not sweep-eligible.
const STATUS_OPTIONS: AgentExecutionStatus[] = ACTIVE_AGENT_EXECUTION_STATUSES.filter(
  s => s !== 'awaiting_subagent' && s !== 'awaiting_dag_children'
);

const formatAge = (updatedAt: string): string => {
  const ms = Date.now() - new Date(updatedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
};

const truncate = (s: string, max = 80): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

const USER_ID_DEBOUNCE_MS = 300;

const AgentExecutionsTab: React.FC = () => {
  const [minutes, setMinutes] = useState(20);
  const [status, setStatus] = useState<AgentExecutionStatus | ''>('');
  const [userId, setUserId] = useState('');
  // Debounced mirror of `userId` so each keystroke doesn't fire a request.
  // A 24-char ObjectId would otherwise trigger 24 fetches.
  const [debouncedUserId, setDebouncedUserId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedUserId(userId.trim()), USER_ID_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [userId]);

  const queryParams = useMemo(
    () => ({
      minutes,
      ...(status ? { status } : {}),
      ...(debouncedUserId ? { userId: debouncedUserId } : {}),
      limit: 200,
    }),
    [minutes, status, debouncedUserId]
  );

  const { data, isLoading, isError, error, refetch, isFetching } = useStuckAgentExecutions(queryParams);
  const cleanup = useCleanupAgentExecutions();

  const items: StuckExecutionItem[] = data?.items ?? [];

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(items.map(it => it.id)) : new Set());
  };
  const toggleOne = (id: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleCleanup = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    try {
      const result = await cleanup.mutateAsync(ids);
      const skipped = result.requested - result.marked;
      if (skipped > 0) {
        toast.warning(
          `Marked ${result.marked}/${result.requested} abandoned — ${skipped} reached a terminal state during the request (${result.notifiedConnections} live connections notified)`
        );
      } else {
        toast.success(`Marked ${result.marked} abandoned (${result.notifiedConnections} live connections notified)`);
      }
      setSelected(new Set());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Cleanup failed: ${message}`);
    }
  };

  const allSelected = items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0 && !allSelected;

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Box>
          <Typography level="title-lg">Stuck Agent Executions</Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Active executions whose updatedAt has not advanced past the staleness threshold. The reactive in-Lambda
            sweep handles these for active users — this tab releases slots for users who never come back.{' '}
            <Typography component="code" sx={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
              awaiting_subagent
            </Typography>{' '}
            is excluded; healthy parents can legitimately idle for hours.
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <Button
            variant="outlined"
            startDecorator={isFetching ? <CircularProgress size="sm" /> : <RefreshIcon />}
            onClick={() => refetch()}
            disabled={isFetching}
          >
            Refresh
          </Button>
        </Tooltip>
      </Stack>

      <Sheet variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 'md' }}>
        <Stack direction="row" spacing={2} alignItems="flex-end" flexWrap="wrap">
          <FormControl size="sm" sx={{ minWidth: 140 }}>
            <FormLabel>Older than (minutes)</FormLabel>
            <Input
              type="number"
              slotProps={{ input: { min: 1, max: 60 * 24 * 30 } }}
              value={minutes}
              onChange={e => setMinutes(Math.max(1, Number(e.target.value) || 1))}
              data-testid="stuck-agent-executions-minutes"
            />
          </FormControl>
          <FormControl size="sm" sx={{ minWidth: 200 }}>
            <FormLabel>Status</FormLabel>
            <Select
              value={status}
              onChange={(_, val) => setStatus((val as AgentExecutionStatus) ?? '')}
              data-testid="stuck-agent-executions-status"
            >
              <Option value="">All sweepable</Option>
              {STATUS_OPTIONS.map(s => (
                <Option key={s} value={s}>
                  {s}
                </Option>
              ))}
            </Select>
          </FormControl>
          <FormControl size="sm" sx={{ minWidth: 260 }}>
            <FormLabel>User ID</FormLabel>
            <Input
              placeholder="Optional — filter by userId"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              data-testid="stuck-agent-executions-user-id"
            />
          </FormControl>
          <Button
            color="danger"
            startDecorator={<CleaningServicesIcon />}
            disabled={selected.size === 0 || cleanup.isPending}
            onClick={handleCleanup}
            data-testid="stuck-agent-executions-cleanup-btn"
          >
            Mark abandoned ({selected.size})
          </Button>
        </Stack>
      </Sheet>

      {isError && (
        <Alert
          color="danger"
          sx={{ mb: 2 }}
          endDecorator={
            <Button size="sm" variant="soft" color="danger" onClick={() => refetch()}>
              Retry
            </Button>
          }
        >
          Failed to load stuck executions{error instanceof Error ? `: ${error.message}` : ''}
        </Alert>
      )}

      {isLoading ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress />
        </Stack>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'auto' }}>
          <Table size="sm" stickyHeader hoverRow>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={e => toggleAll(e.target.checked)}
                    data-testid="stuck-agent-executions-select-all"
                  />
                </th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ width: 90 }}>Age</th>
                <th style={{ width: 220 }}>User</th>
                <th>Query</th>
                <th style={{ width: 140 }}>Model</th>
                <th style={{ width: 100 }}>Credits</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <Typography level="body-sm" sx={{ textAlign: 'center', py: 3 }}>
                      No stuck executions match these filters.
                    </Typography>
                  </td>
                </tr>
              ) : (
                items.map(item => {
                  const isSelected = selected.has(item.id);
                  return (
                    <tr key={item.id} data-testid={`stuck-execution-row-${item.id}`}>
                      <td>
                        <Checkbox
                          checked={isSelected}
                          onChange={e => toggleOne(item.id, e.target.checked)}
                          data-testid={`stuck-execution-checkbox-${item.id}`}
                        />
                      </td>
                      <td>
                        <Chip size="sm" variant="soft" color="warning">
                          {item.status}
                        </Chip>
                      </td>
                      <td>
                        <Typography level="body-sm">{formatAge(item.updatedAt)}</Typography>
                      </td>
                      <td>
                        <Tooltip title={item.userId} placement="top">
                          <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                            {item.userId.slice(0, 8)}…
                          </Typography>
                        </Tooltip>
                      </td>
                      <td>
                        <Tooltip title={item.query} placement="top">
                          <Typography level="body-sm">{truncate(item.query, 100)}</Typography>
                        </Tooltip>
                      </td>
                      <td>
                        <Typography level="body-xs">{item.model}</Typography>
                      </td>
                      <td>
                        <Typography level="body-sm">{item.totalCreditsUsed.toFixed(2)}</Typography>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Table>
        </Sheet>
      )}

      <Typography level="body-xs" sx={{ mt: 1, color: 'text.tertiary' }}>
        {items.length === 200
          ? `Showing first 200 rows — narrow filters if you need to see more`
          : `Showing ${items.length} row${items.length === 1 ? '' : 's'}`}
      </Typography>
    </Box>
  );
};

export default AgentExecutionsTab;
