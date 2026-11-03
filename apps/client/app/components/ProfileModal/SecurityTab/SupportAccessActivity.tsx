import { useQuery } from '@tanstack/react-query';
import { Stack, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/apiClient';

type Access = { id: string; message: string; startedAt: string; endedAt: string | null; durationMs: number };

export function SupportAccessActivity() {
  const records = useQuery({
    queryKey: ['security', 'support-access'],
    queryFn: async () => (await api.get<{ items: Access[] }>('/api/security/support-access')).data,
  });
  return (
    <Stack spacing={1} data-testid="support-access-activity">
      {records.isError && (
        <Typography level="body-sm" color="danger" role="alert">
          Could not load support access records.
        </Typography>
      )}
      {records.isLoading && <Typography level="body-sm">Loading support access records...</Typography>}
      {records.data?.items.length === 0 && <Typography level="body-sm">No support access recorded.</Typography>}
      {records.data?.items.map(row => (
        <div key={row.id}>
          <Typography level="body-sm">{row.message}</Typography>
          <Typography level="body-xs">
            {new Date(row.startedAt).toLocaleString()} - {Math.ceil(row.durationMs / 60_000)} minutes
            {!row.endedAt ? ' (in progress)' : ''}
          </Typography>
        </div>
      ))}
    </Stack>
  );
}
