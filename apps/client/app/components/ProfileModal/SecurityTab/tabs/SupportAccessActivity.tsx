import { useQuery } from '@tanstack/react-query';
import { Sheet, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/apiClient';

type Access = { id: string; message: string; startedAt: string; endedAt: string | null; durationMs: number };

export function SupportAccessActivity() {
  const records = useQuery({
    queryKey: ['security', 'support-access'],
    queryFn: async () => (await api.get<{ items: Access[] }>('/api/security/support-access')).data,
  });
  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'md' }} data-testid="support-access-activity">
      <Typography level="title-md">Support access</Typography>
      {records.isError && <Typography role="alert">Could not load support access records.</Typography>}
      {records.isLoading && <Typography>Loading support access records...</Typography>}
      {records.data?.items.length === 0 && <Typography>No support access recorded.</Typography>}
      {records.data?.items.map(row => (
        <div key={row.id}>
          <Typography>{row.message}</Typography>
          <Typography level="body-sm">
            {new Date(row.startedAt).toLocaleString()} - {Math.ceil(row.durationMs / 60_000)} minutes
            {!row.endedAt ? ' (in progress)' : ''}
          </Typography>
        </div>
      ))}
    </Sheet>
  );
}
