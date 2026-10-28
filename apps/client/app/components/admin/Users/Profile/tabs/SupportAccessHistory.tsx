import { useQuery } from '@tanstack/react-query';
import { Typography } from '@mui/joy';
import { api } from '@client/app/contexts/apiClient';
import { DataTable, RelativeTime, SectionCard, type DataColumn } from '../../../shared';

type Access = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  adminId: string;
  reason: string;
  escalated: boolean;
};
const columns: readonly DataColumn<Access>[] = [
  { id: 'started', label: 'Started', render: row => <RelativeTime at={new Date(row.startedAt)} /> },
  { id: 'admin', label: 'Admin', render: row => row.adminId },
  {
    id: 'duration',
    label: 'Duration',
    render: row => `${Math.ceil(row.durationMs / 60_000)} min${row.endedAt ? '' : ' (active)'}`,
  },
  { id: 'mode', label: 'Changes', render: row => (row.escalated ? 'Allowed' : 'Read-only') },
  { id: 'reason', label: 'Reason', render: row => row.reason },
];

export function SupportAccessHistory({ userId }: { userId: string }) {
  const records = useQuery({
    queryKey: ['admin', 'support-access', userId],
    queryFn: async () => (await api.get<{ items: Access[] }>(`/api/admin/users/${userId}/support-access`)).data,
  });
  return (
    <SectionCard title="Support session history" body="custom" data-testid="admin-support-access-history">
      <DataTable
        rows={records.data?.items ?? []}
        columns={columns}
        getRowId={row => row.id}
        label="Support session history"
        loading={records.isLoading}
        error={records.isError ? 'Support sessions could not be loaded.' : undefined}
        onRetry={() => void records.refetch()}
        empty={<Typography>No support sessions recorded.</Typography>}
        testId="admin-support-access-table"
      />
    </SectionCard>
  );
}
