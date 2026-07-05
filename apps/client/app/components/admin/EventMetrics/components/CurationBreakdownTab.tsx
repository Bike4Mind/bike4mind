import React from 'react';
import { Box, Card, CardContent, Grid, Typography } from '@mui/joy';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { ChartData } from '../utils/chartDataProcessor';

interface CurationBreakdownTabProps {
  chartData: ChartData;
}

export const CurationBreakdownTab: React.FC<CurationBreakdownTabProps> = ({ chartData }) => {
  if (!chartData.curationBreakdown || chartData.curationBreakdown.length === 0) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography level="h4">No Curation Data Available</Typography>
        <Typography sx={{ mt: 1 }}>Curation events with file type metadata will appear here once tracked.</Typography>
      </Box>
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
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="fileType" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="transcript" fill="#0088FE" name="Transcript" stackId="a" />
                  <Bar dataKey="executive_summary" fill="#00C49F" name="Executive Summary" stackId="a" />
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
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="fileType" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="markdown" fill="#FFBB28" name="Markdown" stackId="a" />
                  <Bar dataKey="txt" fill="#FF8042" name="TXT" stackId="a" />
                  <Bar dataKey="html" fill="#8884D8" name="HTML" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};
