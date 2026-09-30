import { FC } from 'react';
import { Card, Table, Typography } from '@mui/joy';
import type { QaFlakyRow } from '@client/app/hooks/data/qaStatus';

const FlakyTable: FC<{ rows: QaFlakyRow[]; onOpenTest: (testKey: string) => void }> = ({ rows, onOpenTest }) => (
  <Card variant="outlined">
    <Typography level="title-sm">Flaky tests</Typography>
    {rows.length === 0 ? (
      <Typography data-testid="qa-flaky-empty" level="body-sm">
        No flaky tests in range.
      </Typography>
    ) : (
      <Table size="sm" hoverRow>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.testKey}
              data-testid="qa-flaky-row"
              onClick={() => onOpenTest(r.testKey)}
              style={{ cursor: 'pointer' }}
            >
              <td>{r.title}</td>
              <td style={{ width: 120, textAlign: 'right' }}>
                failed {r.failures}/{r.total}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    )}
  </Card>
);

export default FlakyTable;
