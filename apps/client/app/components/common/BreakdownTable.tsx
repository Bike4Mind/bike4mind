import React from 'react';
import { Box, Sheet, Table, Typography } from '@mui/joy';
import { formatUsd, formatCredits, numberCell } from '@client/app/utils/formatUsd';

export type BreakdownRow = {
  key: string;
  label: string;
  title?: string;
  requests: number;
  cogsUsd: number;
  creditsCharged: number;
};

/** A ranked usage breakdown table (by model/feature/member/etc.), shared by every usage-summary
 * surface (admin UsageDashboard, the data-lake spend view) so they render identically. */
export const BreakdownTable: React.FC<{
  title: string;
  keyLabel: string;
  testid: string;
  rows: BreakdownRow[];
  emptyText?: string;
}> = ({ title, keyLabel, testid, rows, emptyText = 'No usage in this window.' }) => (
  <Box>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      {title}
    </Typography>
    <Sheet sx={{ maxHeight: 320, overflow: 'auto' }}>
      <Table stickyHeader hoverRow size="sm" data-testid={testid}>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th style={{ textAlign: 'right' }}>Requests</th>
            <th style={{ textAlign: 'right' }}>COGS (USD)</th>
            <th style={{ textAlign: 'right' }}>Credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <td title={row.title}>{row.label}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{row.requests.toLocaleString()}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatUsd(row.cogsUsd)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(row.creditsCharged)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4}>
                <Typography level="body-sm" color="neutral">
                  {emptyText}
                </Typography>
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </Sheet>
  </Box>
);
