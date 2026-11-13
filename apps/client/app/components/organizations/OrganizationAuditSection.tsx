import { useState } from 'react';
import { Alert, Button, FormControl, FormLabel, Input, Stack, Table, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

interface AuditPage {
  events: { id: string; occurredAt: string; actorUserId: string; action: string; targetId?: string }[];
  nextCursor: string | null;
}

export default function OrganizationAuditSection({ organizationId }: { organizationId: string }) {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [before, setBefore] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const params = {
    actor: actor || undefined,
    action: action || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const { data, isPending, isError } = useQuery({
    queryKey: ['organizations', organizationId, 'audit', params, before],
    queryFn: async () =>
      (await api.get<AuditPage>(`/api/organizations/${organizationId}/audit`, { params: { ...params, before } })).data,
  });
  const exportCsv = async () => {
    setExporting(true);
    setExportError(false);
    try {
      const response = await api.get<Blob>(`/api/organizations/${organizationId}/audit`, {
        params: { ...params, format: 'csv' },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'organization-audit.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };
  return (
    <Stack spacing={2} data-testid="organization-audit-section">
      <Typography level="title-lg">Audit</Typography>
      <Typography level="body-sm">
        Organization activity recorded from the time audit logging was enabled. Dates use UTC.
      </Typography>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {[
          { label: 'Actor ID', value: actor, set: setActor, type: 'text', id: 'actor' },
          { label: 'Event type', value: action, set: setAction, type: 'text', id: 'action' },
          { label: 'From (UTC)', value: from, set: setFrom, type: 'date', id: 'from' },
          { label: 'To (UTC)', value: to, set: setTo, type: 'date', id: 'to' },
        ].map(field => (
          <FormControl key={field.id}>
            <FormLabel>{field.label}</FormLabel>
            <Input
              type={field.type}
              value={field.value}
              data-testid={`organization-audit-${field.id}-input`}
              onChange={event => {
                field.set(event.target.value);
                setBefore(undefined);
              }}
            />
          </FormControl>
        ))}
      </Stack>
      <Button
        data-testid="organization-audit-export-btn"
        disabled={!from || !to || from > to}
        loading={exporting}
        onClick={exportCsv}
      >
        Export date range as CSV
      </Button>
      {(isError || exportError) && (
        <Alert color="danger">Could not load audit events. Check the filters or use a smaller date range.</Alert>
      )}
      {isPending ? (
        <Typography>Loading audit events...</Typography>
      ) : (
        <Table data-testid="organization-audit-table">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Actor ID</th>
              <th>Event</th>
              <th>Target ID</th>
            </tr>
          </thead>
          <tbody>
            {data?.events.map(event => (
              <tr key={event.id}>
                <td>{new Date(event.occurredAt).toISOString()}</td>
                <td>{event.actorUserId}</td>
                <td>{event.action}</td>
                <td>{event.targetId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {!isPending && !isError && !data?.events.length && <Typography>No matching audit events.</Typography>}
      <Stack direction="row" spacing={2}>
        <Button
          variant="outlined"
          data-testid="organization-audit-first-btn"
          disabled={!before}
          onClick={() => setBefore(undefined)}
        >
          Newest
        </Button>
        <Button
          variant="outlined"
          data-testid="organization-audit-next-btn"
          disabled={!data?.nextCursor}
          onClick={() => setBefore(data?.nextCursor ?? undefined)}
        >
          Older
        </Button>
      </Stack>
    </Stack>
  );
}
