import { useState } from 'react';
import { Alert, Button, Checkbox, Option, Select, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { DataTable } from './shared/DataTable';

const QUERY_KEY = ['held-signup-grants'];
const ENDPOINT = '/api/admin/held-signup-grants';

type HeldReason = 'budget_exhausted';
type HeldRow = { id: string; email: string | null; reason: HeldReason; createdAt: string };
type ReleaseResult = {
  batchId: string;
  results: { userId: string; outcome: string; credits: number }[];
};
type UndoResult = { batchId: string; results: { userId: string; outcome: string; credits: number }[] };

const REASON_LABELS: Record<HeldReason, string> = {
  budget_exhausted: 'Daily budget spent',
};

export default function HeldSignupGrantsTab() {
  const [reason, setReason] = useState<HeldReason | 'all'>('all');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const after = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: [...QUERY_KEY, reason, after],
    queryFn: async () =>
      (
        await api.get<{ data: HeldRow[]; nextCursor: string | null }>(ENDPOINT, {
          params: { ...(reason === 'all' ? {} : { reason }), ...(after ? { after } : {}) },
        })
      ).data,
  });
  const release = useMutation({
    mutationFn: async (userIds: string[]) => (await api.post<ReleaseResult>(`${ENDPOINT}/release`, { userIds })).data,
    onSuccess: async () => {
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const undo = useMutation({
    mutationFn: async (batchId: string) => (await api.post<UndoResult>(`${ENDPOINT}/undo`, { batchId })).data,
  });
  const rows = query.data?.data ?? [];
  const busy = release.isPending || undo.isPending;
  const toggle = (id: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const paid = release.data?.results.filter(result => result.outcome === 'released') ?? [];

  return (
    <Stack spacing={2} data-testid="held-signup-grants-tab">
      <Typography level="h3">Held signup grants</Typography>
      <Typography>
        Free credits withheld from new accounts, oldest first. A grant held by the daily budget is also paid
        automatically once a new day&apos;s budget opens. Releasing here pays the original grant without drawing the
        budget; Undo reclaims only the credits a release paid, and skips balances already spent.
      </Typography>
      {release.error && <Alert color="danger">{getErrorMessage(release.error)}</Alert>}
      {undo.error && <Alert color="danger">{getErrorMessage(undo.error)}</Alert>}
      {release.data && (
        <Alert color="success" data-testid="held-signup-grants-release-result">
          Released {paid.length} of {release.data.results.length} grants
          {' ('}
          {paid.reduce((sum, result) => sum + result.credits, 0)} credits).
          <Button
            size="sm"
            variant="outlined"
            sx={{ ml: 2 }}
            data-testid="held-signup-grants-undo-btn"
            disabled={busy || !paid.length}
            onClick={() => undo.mutate(release.data.batchId)}
          >
            Undo
          </Button>
        </Alert>
      )}
      {undo.data && (
        <Alert color="neutral" data-testid="held-signup-grants-undo-result">
          Reversed {undo.data.results.filter(result => result.outcome === 'reversed').length} of{' '}
          {undo.data.results.length} grants.
        </Alert>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Select
          size="sm"
          value={reason}
          data-testid="held-signup-grants-reason-select"
          onChange={(_event, value) => {
            setReason(value ?? 'all');
            setCursors([undefined]);
            setSelected(new Set());
          }}
        >
          <Option value="all">All reasons</Option>
          <Option value="budget_exhausted">{REASON_LABELS.budget_exhausted}</Option>
        </Select>
        <Button
          size="sm"
          data-testid="held-signup-grants-release-btn"
          disabled={busy || selected.size === 0}
          loading={release.isPending}
          onClick={() => release.mutate([...selected])}
        >
          Release selected ({selected.size})
        </Button>
        <Button
          size="sm"
          variant="outlined"
          data-testid="held-signup-grants-previous"
          disabled={cursors.length === 1 || query.isPending}
          onClick={() => setCursors(current => current.slice(0, -1))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outlined"
          data-testid="held-signup-grants-next"
          disabled={!query.data?.nextCursor || query.isPending}
          onClick={() => setCursors(current => [...current, query.data?.nextCursor ?? undefined])}
        >
          Next
        </Button>
      </Stack>
      <DataTable<HeldRow>
        rows={rows}
        getRowId={row => row.id}
        label="Held signup grants"
        loading={query.isPending}
        error={query.error ? getErrorMessage(query.error) : undefined}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        empty={<Typography>No signup grants are held.</Typography>}
        columns={[
          {
            id: 'select',
            label: '',
            render: row => (
              <Checkbox
                checked={selected.has(row.id)}
                disabled={busy}
                slotProps={{ input: { 'data-testid': `held-signup-grants-select-${row.id}` } }}
                onChange={() => toggle(row.id)}
              />
            ),
          },
          { id: 'email', label: 'Account', render: row => row.email ?? row.id },
          { id: 'reason', label: 'Reason', render: row => REASON_LABELS[row.reason] },
          { id: 'created', label: 'Signed up', render: row => new Date(row.createdAt).toLocaleString() },
        ]}
      />
    </Stack>
  );
}
