import React, { type ReactNode } from 'react';
import { Stack } from '@mui/joy';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { ChartData } from '../utils/chartDataProcessor';
import {
  adminChartSeries,
  chartAxisProps,
  chartGridProps,
  chartLegendProps,
  chartTooltipProps,
} from '../utils/chartTheme';
import { ChartDataTable, ChartSection, EmptyState } from '../../shared';

interface CurationBreakdownTabProps {
  chartData: ChartData;
  /** The page's range or filters are set, so an empty breakdown may be down to them. */
  filtered: boolean;
  /** The empty state's next step: Clear filters when `filtered`, else a refresh. */
  emptyAction: ReactNode;
}

const [TRANSCRIPT_COLOR, SUMMARY_COLOR] = adminChartSeries(2);
const [MARKDOWN_COLOR, TXT_COLOR, HTML_COLOR] = adminChartSeries(3);

export const CurationBreakdownTab: React.FC<CurationBreakdownTabProps> = ({ chartData, filtered, emptyAction }) => {
  if (!chartData.curationBreakdown || chartData.curationBreakdown.length === 0) {
    return filtered ? (
      <EmptyState title="No curation events in this range" action={emptyAction} />
    ) : (
      <EmptyState
        title="No curation events yet"
        description="Curation events with file type metadata appear here once tracked."
        action={emptyAction}
      />
    );
  }

  const curationTypeData = chartData.curationBreakdown.map(item => ({
    fileType: item.fileType,
    transcript: item.curationType?.transcript || 0,
    executive_summary: item.curationType?.executive_summary || 0,
  }));

  const exportFormatData = chartData.curationBreakdown.map(item => ({
    fileType: item.fileType,
    markdown: item.exportFormat?.markdown || 0,
    txt: item.exportFormat?.txt || 0,
    html: item.exportFormat?.html || 0,
  }));

  const curationTotal = curationTypeData.reduce((sum, row) => sum + row.transcript + row.executive_summary, 0);
  const exportTotal = exportFormatData.reduce((sum, row) => sum + row.markdown + row.txt + row.html, 0);
  const count = (value: number) => value.toLocaleString();
  const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
  const fileTypes = plural(curationTypeData.length, 'file type');

  return (
    <Stack gap={2}>
      <ChartSection
        title="Curation types by file type"
        testId="curation-types"
        body={
          curationTotal === 0
            ? { kind: 'notice', content: <EmptyState title="No curations recorded" action={null} /> }
            : {
                kind: 'ready',
                caption: `${plural(curationTotal, 'curation')} across ${fileTypes}`,
                chart: (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={curationTypeData}>
                      <CartesianGrid {...chartGridProps} />
                      <XAxis dataKey="fileType" {...chartAxisProps} />
                      <YAxis {...chartAxisProps} />
                      <Tooltip {...chartTooltipProps} />
                      <Legend {...chartLegendProps} />
                      <Bar dataKey="transcript" fill={TRANSCRIPT_COLOR} name="Transcript" stackId="a" />
                      <Bar dataKey="executive_summary" fill={SUMMARY_COLOR} name="Executive Summary" stackId="a" />
                    </BarChart>
                  </ResponsiveContainer>
                ),
                table: (
                  <ChartDataTable
                    label="Curation types by file type"
                    testId="curation-types-table"
                    rows={curationTypeData}
                    getRowId={row => row.fileType}
                    columns={[
                      { id: 'fileType', label: 'File type', render: row => row.fileType },
                      { id: 'transcript', label: 'Transcript', numeric: true, render: row => count(row.transcript) },
                      {
                        id: 'executive_summary',
                        label: 'Executive Summary',
                        numeric: true,
                        render: row => count(row.executive_summary),
                      },
                    ]}
                  />
                ),
              }
        }
      />

      <ChartSection
        title="Export formats by file type"
        testId="export-formats"
        body={
          exportTotal === 0
            ? { kind: 'notice', content: <EmptyState title="No exports recorded" action={null} /> }
            : {
                kind: 'ready',
                caption: `${plural(exportTotal, 'export')} across ${fileTypes}`,
                chart: (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={exportFormatData}>
                      <CartesianGrid {...chartGridProps} />
                      <XAxis dataKey="fileType" {...chartAxisProps} />
                      <YAxis {...chartAxisProps} />
                      <Tooltip {...chartTooltipProps} />
                      <Legend {...chartLegendProps} />
                      <Bar dataKey="markdown" fill={MARKDOWN_COLOR} name="Markdown" stackId="a" />
                      <Bar dataKey="txt" fill={TXT_COLOR} name="TXT" stackId="a" />
                      <Bar dataKey="html" fill={HTML_COLOR} name="HTML" stackId="a" />
                    </BarChart>
                  </ResponsiveContainer>
                ),
                table: (
                  <ChartDataTable
                    label="Export formats by file type"
                    testId="export-formats-table"
                    rows={exportFormatData}
                    getRowId={row => row.fileType}
                    columns={[
                      { id: 'fileType', label: 'File type', render: row => row.fileType },
                      { id: 'markdown', label: 'Markdown', numeric: true, render: row => count(row.markdown) },
                      { id: 'txt', label: 'TXT', numeric: true, render: row => count(row.txt) },
                      { id: 'html', label: 'HTML', numeric: true, render: row => count(row.html) },
                    ]}
                  />
                ),
              }
        }
      />
    </Stack>
  );
};
