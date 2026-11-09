import React, { type ReactNode } from 'react';
import { Box, Card, CardContent, Grid, Typography } from '@mui/joy';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { ChartData } from '../utils/chartDataProcessor';
import {
  adminChartSeries,
  chartAxisProps,
  chartGridProps,
  chartLegendProps,
  chartTooltipProps,
} from '../utils/chartTheme';
import { EmptyState } from '../../shared';

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
      <EmptyState title="No events match these filters" action={emptyAction} />
    ) : (
      <EmptyState
        title="No curation events yet"
        description="Curation events with file type metadata appear here once tracked."
        action={emptyAction}
      />
    );
  }

  // Prepare data for curation type breakdown
  const curationTypeData = chartData.curationBreakdown.map(item => ({
    fileType: item.fileType,
    transcript: item.curationType?.transcript || 0,
    executive_summary: item.curationType?.executive_summary || 0,
  }));

  // Prepare data for export format breakdown
  const exportFormatData = chartData.curationBreakdown.map(item => ({
    fileType: item.fileType,
    markdown: item.exportFormat?.markdown || 0,
    txt: item.exportFormat?.txt || 0,
    html: item.exportFormat?.html || 0,
  }));

  return (
    <Box>
      <Grid container spacing={2}>
        {/* Curation Type Breakdown */}
        <Grid xs={12}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Curation Types by File Type
              </Typography>
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
            </CardContent>
          </Card>
        </Grid>

        {/* Export Format Breakdown */}
        <Grid xs={12}>
          <Card>
            <CardContent>
              <Typography level="h4" sx={{ mb: 2 }}>
                Export Formats by File Type
              </Typography>
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
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
