import { Box, Stack, Tooltip, Typography } from '@mui/joy';
import { styled } from '@mui/system';

/**
 * The seven token buckets an assembled turn is billed against, matching
 * `promptMeta.context.tokensBySource` and `contextTelemetry.contextWindow.tokensBySource` - shared
 * by the admin Context Inspector and the user's own context breakdown, which must colour and label
 * the same buckets identically.
 */
export type TokenDistribution = {
  systemPrompts: number;
  conversationHistory: number;
  mementos: number;
  fabFiles: number;
  urlContent: number;
  toolSchemas: number;
  userPrompt: number;
};

const TokenSegment = styled('div')<{ width: number; color: string }>(({ width, color }) => ({
  width: `${width}%`,
  height: '100%',
  backgroundColor: color,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '10px',
  color: 'white',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}));

export const TOKEN_SOURCE_COLORS: Record<string, string> = {
  systemPrompts: '#3f51b5',
  conversationHistory: '#2196f3',
  mementos: '#00bcd4',
  fabFiles: '#009688',
  urlContent: '#8bc34a',
  toolSchemas: '#4caf50',
  userPrompt: '#ff9800',
};

export const TokenDistributionBar = ({ tokensBySource }: { tokensBySource: TokenDistribution }) => {
  const total =
    tokensBySource.systemPrompts +
    tokensBySource.conversationHistory +
    tokensBySource.mementos +
    tokensBySource.fabFiles +
    tokensBySource.urlContent +
    tokensBySource.toolSchemas +
    tokensBySource.userPrompt;

  if (total === 0) return <Typography level="body-sm">No token data</Typography>;

  const segments = [
    { key: 'systemPrompts', label: 'System', value: tokensBySource.systemPrompts },
    { key: 'conversationHistory', label: 'History', value: tokensBySource.conversationHistory },
    { key: 'mementos', label: 'Mementos', value: tokensBySource.mementos },
    { key: 'fabFiles', label: 'Files', value: tokensBySource.fabFiles },
    { key: 'urlContent', label: 'URLs', value: tokensBySource.urlContent },
    { key: 'toolSchemas', label: 'Tools', value: tokensBySource.toolSchemas },
    { key: 'userPrompt', label: 'User', value: tokensBySource.userPrompt },
  ].filter(s => s.value > 0);

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          height: 24,
          borderRadius: 'sm',
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        {segments.map(segment => (
          <Tooltip
            key={segment.key}
            title={`${segment.label}: ${segment.value.toLocaleString()} tokens (${((segment.value / total) * 100).toFixed(1)}%)`}
          >
            <TokenSegment width={(segment.value / total) * 100} color={TOKEN_SOURCE_COLORS[segment.key]}>
              {(segment.value / total) * 100 > 8 ? segment.label : ''}
            </TokenSegment>
          </Tooltip>
        ))}
      </Box>
      <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }}>
        {segments.map(segment => (
          <Stack key={segment.key} direction="row" alignItems="center" spacing={0.5}>
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: 'xs',
                bgcolor: TOKEN_SOURCE_COLORS[segment.key],
              }}
            />
            <Typography level="body-xs">
              {segment.label}: {segment.value.toLocaleString()}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
};

export default TokenDistributionBar;
