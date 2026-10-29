import { adminFocusScope } from './adminStyles';
import { useEffect, useState, type ReactNode } from 'react';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';

/** A value with a copy button; `label` names it for the button ("Copy key prefix"). */
export function CopyValue({
  value,
  label,
  mono,
  'data-testid': testId,
}: {
  value: string;
  label: string;
  mono?: boolean;
  'data-testid'?: string;
}) {
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
    <Stack component="span" direction="row" gap={0.5} alignItems="center" sx={{ minWidth: 0 }}>
      <Typography
        component="span"
        level="body-sm"
        sx={{
          color: 'admin.inkMuted',
          overflowWrap: 'anywhere',
          ...(mono && { fontFamily: 'code', fontSize: 12 }),
        }}
      >
        {value}
      </Typography>
      <Tooltip title={result === 'copied' ? 'Copied' : `Copy ${label}`}>
        <IconButton
          size="sm"
          variant="plain"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
          data-testid={testId ?? `admin-entity-copy-${label}-btn`}
          sx={{ '--IconButton-size': '22px', minHeight: 22, minWidth: 22, color: 'admin.inkMuted' }}
        >
          {result === 'copied' ? (
            <CheckRoundedIcon sx={{ fontSize: 14 }} />
          ) : (
            <ContentCopyRoundedIcon sx={{ fontSize: 13 }} />
          )}
        </IconButton>
      </Tooltip>
      <Typography role="status" level="body-xs" component="span" sx={{ color: 'admin.status.bad.foreground' }}>
        {result === 'error' ? 'Could not copy. Try again.' : ''}
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
  if (Math.abs(seconds) < 86400 * 45) return formatter.format(Math.round(seconds / 86400), 'day');
  if (Math.abs(seconds) < 86400 * 365) return formatter.format(Math.round(seconds / (86400 * 30)), 'month');
  return formatter.format(Math.round(seconds / (86400 * 365)), 'year');
}

/** Exact UTC, for the tooltip on a relative time: "14 Mar 2026, 09:12 UTC". */
export const formatUtc = (date: Date): string =>
  `${date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;

export type EntityTime = { prefix?: string; at: string | Date | null | undefined; 'data-testid'?: string };

/** A relative time with the exact UTC time on hover and focus. Renders nothing for an invalid date. */
export function RelativeTime({ prefix, at, 'data-testid': testId }: EntityTime) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const date = at ? new Date(at) : undefined;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return (
    <Tooltip title={formatUtc(date)}>
      <Typography
        component="time"
        dateTime={date.toISOString()}
        tabIndex={0}
        level="body-sm"
        sx={{ color: 'admin.inkMuted' }}
        data-testid={testId}
      >
        {prefix ? `${prefix} ${relativeTime(date, now)}` : relativeTime(date, now)}
      </Typography>
    </Tooltip>
  );
}

type EntityHeaderProps = {
  title: string;
  id: string;
  email?: string;
  /** Shortcut for a single time line; `times` takes several. */
  timestamp?: string;
  times?: EntityTime[];
  /** Status chips next to the title. */
  status?: ReactNode;
  /** A 56 px identity mark (avatar or initials) left of the title. */
  avatar?: ReactNode;
  /** Extra meta items after the email, id and times. */
  meta?: ReactNode;
  /** Up to two buttons and a More menu (DESIGN_GUIDE.md section 3). */
  actions?: ReactNode;
};

/** Identity of a user, org or key: title, status, copyable email and id, and relative times. */
export function EntityHeader({ title, id, email, timestamp, times, status, avatar, meta, actions }: EntityHeaderProps) {
  const timeLines: EntityTime[] = times ?? (timestamp ? [{ at: timestamp, 'data-testid': 'admin-entity-time' }] : []);
  return (
    <Stack
      component="header"
      direction="row"
      flexWrap="wrap"
      gap={2.5}
      alignItems="flex-start"
      sx={adminFocusScope}
      data-testid="admin-entity-header"
    >
      {avatar && <Box sx={{ flex: 'none' }}>{avatar}</Box>}
      <Box sx={{ flex: '1 1 360px', minWidth: 0 }}>
        <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
          <Typography level="h1" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
            {title}
          </Typography>
          {status}
        </Stack>
        <Stack
          direction="row"
          flexWrap="wrap"
          alignItems="center"
          sx={{ mt: 1, columnGap: 2, rowGap: 0.75, fontSize: 13 }}
        >
          {email && <CopyValue value={email} label="email" />}
          <CopyValue value={id} label="id" mono />
          {timeLines.map((time, index) => (
            <RelativeTime key={index} {...time} />
          ))}
          {meta}
        </Stack>
      </Box>
      {actions && (
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ position: 'relative' }}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
