import { useState } from 'react';
import { Box, Button, IconButton, Sheet, Stack, Typography } from '@mui/joy';
import { DataTable, SectionCard } from '../../shared';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { AuditChange, AuditEntry } from '@bike4mind/common';
import { activateOnKey } from './activateOnKey';
import { copyTextWithToast } from '@client/app/utils/copyToClipboard';

/**
 * Drawer sections hold free-form content (text, tables, link rows), not label/value facts, so they use the
 * `custom` body. The default `facts` body is a two-column `<dl>` that squeezes such content into its label column.
 */
export const DrawerSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <SectionCard title={title} body="custom">
    <Stack spacing={1} sx={{ px: 2, py: 1.75, minWidth: 0 }} data-testid="audit-drawer-section-body">
      {children}
    </Stack>
  </SectionCard>
);

export const KeyValueRows: React.FC<{ rows: Array<[string, string | undefined]> }> = ({ rows }) => (
  <Stack spacing={0.25}>
    {rows
      .filter((row): row is [string, string] => row[1] !== undefined && row[1] !== '')
      .map(([label, value]) => (
        <Typography key={label} level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
          <Typography component="span" level="body-xs" sx={{ mr: 1 }}>
            {label}
          </Typography>
          {value}
        </Typography>
      ))}
  </Stack>
);

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
};

export const ChangesTable: React.FC<{ changes: AuditChange[] }> = ({ changes }) => (
  <DataTable
    rows={changes.map((change, index) => ({ ...change, id: `${index}` }))}
    getRowId={change => change.id}
    label="Recorded changes"
    testId="audit-drawer-changes"
    onRetry={() => {}}
    columns={[
      {
        id: 'field',
        label: 'Field',
        render: change => <Typography sx={{ overflowWrap: 'anywhere' }}>{change.field}</Typography>,
      },
      {
        id: 'before',
        label: 'Before',
        render: change => <Typography sx={{ overflowWrap: 'anywhere' }}>{formatValue(change.before)}</Typography>,
      },
      {
        id: 'after',
        label: 'After',
        render: change => <Typography sx={{ overflowWrap: 'anywhere' }}>{formatValue(change.after)}</Typography>,
      },
    ]}
  />
);

export const CopyableId: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Stack direction="row" spacing={0.5} alignItems="center">
    <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
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
    role={onSelect ? 'button' : undefined}
    tabIndex={onSelect ? 0 : undefined}
    onClick={onSelect && (() => onSelect(entry))}
    onKeyDown={onSelect && activateOnKey(() => onSelect(entry))}
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
