import { useEffect, useState } from 'react';
import { Alert, Button, Card, Stack, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/ApiContext';

interface ExportStatus {
  status: 'pending' | 'ready' | 'expired' | 'failed';
  url?: string;
  expiresAt?: string;
}

export default function OrganizationExportSection({ organizationId }: { organizationId: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<ExportStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const base = `/api/organizations/${organizationId}/data-export`;
  useEffect(() => {
    let active = true;
    api
      .get<{ exportJobId: string | null }>(base)
      .then(response => {
        if (active) setJobId(response.data.exportJobId);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [base]);
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api.get<ExportStatus>(`${base}/${jobId}`);
        if (!active) return;
        setStatus(response.data);
        if (response.data.status === 'pending') timer = setTimeout(poll, 5000);
      } catch {
        if (active) setError(true);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [base, jobId]);
  const request = async () => {
    setBusy(true);
    setError(false);
    try {
      const response = await api.post<{ exportJobId: string }>(base);
      setStatus({ status: 'pending' });
      setJobId(response.data.exportJobId);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    try {
      const response = await api.get<ExportStatus>(`${base}/${jobId}`);
      setStatus(response.data);
      if (response.data.url) window.location.assign(response.data.url);
    } catch {
      setError(true);
    }
  };
  return (
    <Card variant="outlined" data-testid="organization-export-section">
      <Stack spacing={2}>
        <Typography level="title-sm">Export organization data</Typography>
        <Typography level="body-sm">
          Includes organization settings, member roles, usage and billing ledger CSVs, and audit events. Projects,
          notebooks, files, and credentials are not included. Exports expire 24 hours after request. We will email you
          when it is ready.
        </Typography>
        <Button
          data-testid="organization-export-request-btn"
          loading={busy}
          disabled={status?.status === 'pending'}
          onClick={request}
        >
          Request export
        </Button>
        {status?.status === 'pending' && <Typography role="status">Preparing your export...</Typography>}
        {status?.status === 'ready' && (
          <Button data-testid="organization-export-download-btn" onClick={download}>
            Download export
          </Button>
        )}
        {(status?.status === 'expired' || status?.status === 'failed') && (
          <Alert>Export {status.status}. Request a new export.</Alert>
        )}
        {error && (
          <Alert color="danger">
            Could not load or request the export. Requests are limited to one per hour. Refresh to retry.
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
