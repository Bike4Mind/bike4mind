import React from 'react';
import { Box, Stack, Chip, Typography } from '@mui/joy';
import type { RechartsArtifact } from '@bike4mind/common';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { parseChartJSON, ChartParseError, getChartErrorMessage } from '@client/app/utils/chartJsonParser';
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
        sx={{ my: 2, p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}
      >
        <Typography level="body-sm" color="danger">
          Error rendering chart: {errorMessage}
        </Typography>
      </Box>
    );
  }

  const { artifact: rechartsArtifact } = result;

  return (
    <Box
      key={index}
      data-testid={`artifact-preview-recharts-${artifactId}`}
      sx={{
        my: 2,
        cursor: 'pointer',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        p: 2,
        '&:hover': {
          bgcolor: 'background.level1',
        },
      }}
      onClick={() => {
        setSessionLayout({
          layout: 'vertical',
          artifactData: {
            type: 'recharts',
            content: rechartsArtifact,
            mimeType: 'application/vnd.ant.recharts',
            id: rechartsArtifact.id,
          },
        });
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <Box sx={{ color: 'primary.500', fontSize: '1.25rem' }}>📊</Box>
        <Typography level="body-sm">{rechartsArtifact.title}</Typography>
        <Chip size="sm" variant="soft" color="primary">
          {rechartsArtifact.metadata.chartType || 'Chart'}
        </Chip>
      </Stack>
      <Typography level="body-xs" color="neutral">
        {rechartsArtifact.metadata.description ||
          `Interactive chart with ${rechartsArtifact.metadata.dataPoints} data points`}
      </Typography>
    </Box>
  );
};

registerArtifactType({ type: 'recharts', PreviewCard: RechartsPreviewCard });
