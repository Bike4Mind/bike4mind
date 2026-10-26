import { adminFocusScope } from './adminStyles';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Stack, Tooltip, Typography } from '@mui/joy';
import { AdminPageHeader } from './AdminPageHeader';

function CopyValue({ value, label }: { value: string; label: string }) {
  const [result, setResult] = useState<'idle' | 'copied' | 'error'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult('copied');
    } catch {
      setResult('error');
    }
  };
  return (
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
      <Typography level="body-xs" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere', color: 'admin.inkMuted' }}>
        {value}
      </Typography>
      <Button
        size="sm"
        variant="plain"
        aria-label={`Copy ${label}`}
        onClick={() => void copy()}
        data-testid={`admin-entity-copy-${label}-btn`}
      >
        Copy
      </Button>
      <Typography role="status" level="body-xs">
        {result === 'copied' ? 'Copied' : result === 'error' ? 'Could not copy. Try again.' : ''}
      </Typography>
    </Stack>
  );
}
export function relativeTime(date: Date, now: number): string {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  if (Math.abs(seconds) < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86400), 'day');
}
export function EntityHeader({
  title,
  id,
  email,
  timestamp,
  status,
  actions,
}: {
  title: string;
  id: string;
  email?: string;
  timestamp?: string;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const date = timestamp ? new Date(timestamp) : undefined;
  return (
    <Stack gap={1} sx={adminFocusScope} data-testid="admin-entity-header">
      <AdminPageHeader title={title} actions={actions} />
      <CopyValue value={id} label="id" />
      {email && <CopyValue value={email} label="email" />}
      {status}
      {date && Number.isFinite(date.getTime()) && (
        <Tooltip title={date.toISOString()}>
          <Typography
            component="time"
            dateTime={date.toISOString()}
            tabIndex={0}
            level="body-xs"
            sx={{ color: 'admin.inkMuted' }}
            data-testid="admin-entity-time"
          >
            {relativeTime(date, now)}
          </Typography>
        </Tooltip>
      )}
    </Stack>
  );
}
