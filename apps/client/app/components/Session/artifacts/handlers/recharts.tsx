import React from 'react';
import { Box, Typography } from '@mui/joy';
import { BarChart as RechartsIcon } from '@mui/icons-material';
import type { RechartsArtifact } from '@bike4mind/common';
import { parseChartJSON, ChartParseError, getChartErrorMessage } from '@client/app/utils/chartJsonParser';
import RechartsRenderer from '@client/app/components/Charts/RechartsRenderer';
import ArtifactPreviewCard from '@client/app/components/GenAI/ArtifactPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

type ParseResult = { ok: true; artifact: RechartsArtifact } | { ok: false; error: unknown };

const buildRechartsArtifact = (content: string, title: string | undefined, artifactId: string): ParseResult => {
  try {
    const chartConfig = parseChartJSON(content);

    const yAxisValue = chartConfig.config?.yAxis;
    const yAxisString = Array.isArray(yAxisValue) ? yAxisValue[0] : yAxisValue;

    const artifact: RechartsArtifact = {
      id: artifactId,
      type: 'recharts' as const,
      title: title || chartConfig.title || 'Chart',
      content: JSON.stringify(chartConfig),
      metadata: {
        chartType: chartConfig.chartType,
        description: chartConfig.description || '',
        dataPoints: Array.isArray(chartConfig.data) ? chartConfig.data.length : 0,
        xAxis: chartConfig.config?.xAxis,
        yAxis: yAxisString,
        colors: chartConfig.config?.colors,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return { ok: true, artifact };
  } catch (error) {
    return { ok: false, error };
  }
};

const RechartsPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId, index }) => {
  const result = buildRechartsArtifact(artifact.content, artifact.title, artifactId);

  if (!result.ok) {
    const errorMessage =
      result.error instanceof ChartParseError ? getChartErrorMessage(result.error) : 'Invalid artifact data';
    console.error('Error parsing recharts artifact:', result.error);
    return (
      <Box
        key={index}
        data-testid="artifact-preview-recharts-error"
        sx={{ p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}
      >
        <Typography level="body-sm" color="danger">
          Error rendering chart: {errorMessage}
        </Typography>
      </Box>
    );
  }

  const { artifact: chart } = result;
  const { description, dataPoints, chartType } = chart.metadata;

  return (
    <Box data-testid={`artifact-preview-recharts-${artifactId}`}>
      <ArtifactPreviewCard
        artifactId={chart.id}
        artifactType="recharts"
        mimeType="application/vnd.ant.recharts"
        artifactContent={chart}
        title={chart.title}
        icon={<RechartsIcon sx={{ fontSize: '14px' }} />}
        chipLabel={chartType || 'Chart'}
        testIdPrefix="recharts"
        // No `source`: a chart's source is the tool's JSON config, not something the
        // user asked for -- so no copy/save/code-view, and the body is the chart alone.
        stats={
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {description || `Interactive chart with ${dataPoints} data points`}
          </Typography>
        }
        renderPreview={() => (
          <RechartsRenderer config={chart.content} title={chart.title} description={description} forceMode="artifact" />
        )}
      />
    </Box>
  );
};

registerArtifactType({ type: 'recharts', PreviewCard: RechartsPreviewCard });
