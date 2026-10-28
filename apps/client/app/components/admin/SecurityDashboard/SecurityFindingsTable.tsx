import { useState, type ReactNode } from 'react';
import { Button, Drawer, Stack, Typography } from '@mui/joy';
import { DataTable, EmptyState, SectionCard, StatusChip } from '../shared';

export type SecurityFindingRow = {
  id: string;
  title: string;
  severity: string;
  description: string;
  recommendation?: string;
  documentationUrl?: string;
};

export function securitySeverityTone(severity: string) {
  if (severity === 'critical' || severity === 'high' || severity === 'P0' || severity === 'P1') return 'bad';
  if (severity === 'medium' || severity === 'P2') return 'warn';
  return 'neutral';
}

export function SecurityFindingsTable<Row extends SecurityFindingRow>({
  rows,
  testId,
  renderDetail,
  onRetry,
}: {
  rows: Row[];
  testId: string;
  renderDetail?(row: Row): ReactNode;
  onRetry(): void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = rows.find(row => row.id === selectedId);
  return (
    <>
      <DataTable
        rows={rows}
        getRowId={row => row.id}
        label="Security findings"
        testId={testId}
        rowTestId={row => `${testId}-finding-${row.id}`}
        onRetry={onRetry}
        onRowActivate={row => setSelectedId(row.id)}
        empty={
          <EmptyState
            title="No findings reported"
            action={
              <Button variant="outlined" onClick={onRetry} data-testid={`${testId}-refresh-btn`}>
                Refresh findings
              </Button>
            }
          />
        }
        columns={[
          { id: 'title', label: 'Finding', render: row => row.title, sortValue: row => row.title },
          {
            id: 'severity',
            label: 'Severity',
            render: row => <StatusChip tone={securitySeverityTone(row.severity)} label={row.severity} />,
          },
          { id: 'summary', label: 'Summary', render: row => row.description },
        ]}
      />
      <Drawer open={Boolean(selected)} onClose={() => setSelectedId(undefined)} anchor="right" size="md">
        {selected && (
          <Stack spacing={2} sx={{ p: 2, overflowY: 'auto' }} data-testid={`${testId}-detail`}>
            <Button variant="plain" onClick={() => setSelectedId(undefined)} data-testid={`${testId}-close-btn`}>
              Close finding
            </Button>
            <SectionCard title={selected.title}>
              <StatusChip tone={securitySeverityTone(selected.severity)} label={selected.severity} />
              <Typography sx={{ overflowWrap: 'anywhere', mt: 1 }}>{selected.description}</Typography>
              {selected.recommendation && <Typography sx={{ mt: 1 }}>{selected.recommendation}</Typography>}
              {selected.documentationUrl?.startsWith('https://') && (
                <Button
                  component="a"
                  variant="plain"
                  href={selected.documentationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`${testId}-guidance-link`}
                >
                  View guidance
                </Button>
              )}
              {renderDetail?.(selected)}
            </SectionCard>
          </Stack>
        )}
      </Drawer>
    </>
  );
}
