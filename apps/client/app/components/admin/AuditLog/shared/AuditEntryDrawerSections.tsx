import { useState } from 'react';
import { Box, Button, IconButton, Sheet, Stack, Table, Typography } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { AuditChange, AuditEntry } from '@bike4mind/common';
import { activateOnKey } from './activateOnKey';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';

export const DrawerSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Box>
    <Typography level="title-sm" sx={{ mb: 0.5 }}>
      {title}
    </Typography>
    {children}
  </Box>
);

export const KeyValueRows: React.FC<{ rows: Array<[string, string | undefined]> }> = ({ rows }) => (
  <Stack spacing={0.25}>
    {rows
      .filter((row): row is [string, string] => row[1] !== undefined && row[1] !== '')
      .map(([label, value]) => (
        <Typography key={label} level="body-sm" sx={{ wordBreak: 'break-all' }}>
          <Typography component="span" level="body-xs" sx={{ mr: 1 }}>
            {label}
          </Typography>
          {value}
        </Typography>
      ))}
  </Stack>
);

const WRAP_STYLE = { overflowWrap: 'anywhere' } as const;

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
};

export const ChangesTable: React.FC<{ changes: AuditChange[] }> = ({ changes }) => (
  <Table size="sm" data-testid="audit-drawer-changes">
    <thead>
      <tr>
        <th>Field</th>
        <th>Before</th>
        <th>After</th>
      </tr>
    </thead>
    <tbody>
      {changes.map((change, index) => (
        <tr key={`${change.field}-${index}`}>
          <td style={WRAP_STYLE}>{change.field}</td>
          <td style={WRAP_STYLE}>{formatValue(change.before)}</td>
          <td style={WRAP_STYLE}>{formatValue(change.after)}</td>
        </tr>
      ))}
    </tbody>
  </Table>
);

export const CopyableId: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Stack direction="row" spacing={0.5} alignItems="center">
    <Typography level="body-sm" sx={{ wordBreak: 'break-all' }}>
      <Typography component="span" level="body-xs" sx={{ mr: 1 }}>
        {label}
      </Typography>
      {value}
    </Typography>
    <IconButton
      size="sm"
      variant="plain"
      aria-label={`Copy ${label}`}
      data-testid="audit-drawer-copy-btn"
      onClick={() => copyTextWithToast(value)}
    >
      <ContentCopyIcon fontSize="small" />
    </IconButton>
  </Stack>
);

export const CollapsibleJson: React.FC<{ value: Record<string, unknown> }> = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <Box>
      <Button size="sm" variant="plain" color="neutral" onClick={() => setExpanded(current => !current)}>
        {expanded ? 'Hide details' : 'Show details'}
      </Button>
      {expanded && (
        <Sheet variant="soft" sx={{ p: 1, borderRadius: 'sm', overflow: 'auto' }}>
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
              maxHeight: 400,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(value, null, 2)}
          </pre>
        </Sheet>
      )}
    </Box>
  );
};

export const RelatedEventRow: React.FC<{ entry: AuditEntry; onSelect?(entry: AuditEntry): void }> = ({
  entry,
  onSelect,
}) => (
  <Sheet
    variant="outlined"
    data-testid={`audit-drawer-related-row-${entry.id}`}
    role="button"
    tabIndex={0}
    onClick={() => onSelect?.(entry)}
    onKeyDown={activateOnKey(() => onSelect?.(entry))}
    sx={{
      p: 1,
      borderRadius: 'sm',
      cursor: onSelect ? 'pointer' : 'default',
      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.500' },
    }}
  >
    <Typography level="body-sm">{entry.summary}</Typography>
    <Typography level="body-xs">{new Date(entry.occurredAt).toLocaleString()}</Typography>
  </Sheet>
);
