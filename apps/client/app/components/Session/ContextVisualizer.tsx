import React, { useMemo } from 'react';
import { Box, Typography, Stack, Button } from '@mui/joy';
import { PromptMeta } from '@bike4mind/common';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';

interface ContextVisualizerProps {
  promptMeta: PromptMeta;
}

type ViewMode = 'tokens' | 'bytes';

const ContextVisualizer: React.FC<ContextVisualizerProps> = ({ promptMeta }) => {
  const [viewMode, setViewMode] = React.useState<ViewMode>('tokens');
  const { data: modelInfoRepo } = useModelInfo();

  // Calculate token counts from promptMeta
  const contextData = useMemo(() => {
    const inputTokens = promptMeta.tokenUsage?.inputTokens || 0;
    const actualInputTokens = promptMeta.tokenUsage?.actualInputTokens || inputTokens;
    const outputTokens = promptMeta.tokenUsage?.outputTokens || 0;
    const actualOutputTokens = promptMeta.tokenUsage?.actualOutputTokens || outputTokens;

    // Get model info from repository if available, otherwise fall back to promptMeta
    const modelInfo = modelInfoRepo?.find(m => m.id === promptMeta.model?.name);

    // Get actual model context window and max tokens from model info or promptMeta
    const contextWindow = modelInfo?.contextWindow || promptMeta.model?.contextWindow || 200000;
    const maxOutputTokens =
      modelInfo?.max_tokens || promptMeta.model?.maxTokens || promptMeta.model?.parameters?.maxTokens || 16384;

    // Calculate components with more accurate distribution based on available data
    // If we have specific counts, use them to better estimate distribution
    const totalContextItems =
      (promptMeta.context?.messageHistoryLength || 0) +
      (promptMeta.context?.totalSystemPromptCount || 0) +
      (promptMeta.context?.mementoCount || 0) +
      (promptMeta.context?.attachedFiles?.length || 0) +
      (promptMeta.context?.knowledgeBaseEntries?.length || 0);

    // Better distribution based on actual item counts when available
    let messageHistoryTokens, systemPromptsTokens, mementosTokens, attachedFilesTokens, knowledgeBaseTokens;

    if (totalContextItems > 0 && actualInputTokens > 0) {
      // Use actual item counts to estimate distribution
      const messageHistoryRatio = (promptMeta.context?.messageHistoryLength || 0) / totalContextItems;
      const systemPromptsRatio = (promptMeta.context?.totalSystemPromptCount || 0) / totalContextItems;
      const mementosRatio = (promptMeta.context?.mementoCount || 0) / totalContextItems;
      const attachedFilesRatio = (promptMeta.context?.attachedFiles?.length || 0) / totalContextItems;
      const knowledgeBaseRatio = (promptMeta.context?.knowledgeBaseEntries?.length || 0) / totalContextItems;

      // Apply ratios with some weighting for typical token density
      messageHistoryTokens = Math.floor(actualInputTokens * messageHistoryRatio * 0.8); // Messages tend to be shorter
      systemPromptsTokens = Math.floor(actualInputTokens * systemPromptsRatio * 1.2); // System prompts are denser
      mementosTokens = Math.floor(actualInputTokens * mementosRatio * 1.0);
      attachedFilesTokens = Math.floor(actualInputTokens * attachedFilesRatio * 1.5); // Files tend to be larger
      knowledgeBaseTokens = Math.floor(actualInputTokens * knowledgeBaseRatio * 1.3); // KB entries are substantial
    } else {
      // Fall back to typical distribution if no specific data
      messageHistoryTokens = Math.floor(actualInputTokens * 0.4); // ~40% for message history
      systemPromptsTokens = Math.floor(actualInputTokens * 0.15); // ~15% for system prompts
      mementosTokens = Math.floor(actualInputTokens * 0.1); // ~10% for mementos
      attachedFilesTokens = Math.floor(actualInputTokens * 0.2); // ~20% for attached files
      knowledgeBaseTokens = Math.floor(actualInputTokens * 0.1); // ~10% for KB entries
    }

    const otherTokens = Math.max(
      0,
      actualInputTokens -
        (messageHistoryTokens + systemPromptsTokens + mementosTokens + attachedFilesTokens + knowledgeBaseTokens)
    );

    // More accurate breakdown if we have specific data
    const breakdown = {
      messageHistory: {
        tokens: messageHistoryTokens,
        bytes: messageHistoryTokens * 4, // Rough estimate: 1 token ≈ 4 bytes
        count: promptMeta.context?.messageHistoryLength || 0,
        label: 'Message History',
        color: '244', // Gray
        duplicates: 0,
      },
      systemPrompts: {
        tokens: systemPromptsTokens,
        bytes: systemPromptsTokens * 4,
        count: promptMeta.context?.totalSystemPromptCount || 0,
        duplicates: promptMeta.context?.duplicateSystemPromptCount || 0,
        label: 'System Prompts',
        color: '246', // Light gray
      },
      mementos: {
        tokens: mementosTokens,
        bytes: mementosTokens * 4,
        count: promptMeta.context?.mementoCount || 0,
        label: 'Mementos (RAG)',
        color: '174', // Pink
        duplicates: 0,
      },
      attachedFiles: {
        tokens: attachedFilesTokens,
        bytes: attachedFilesTokens * 4,
        count: promptMeta.context?.attachedFiles?.length || 0,
        label: 'Attached Files',
        color: '135', // Purple
        duplicates: 0,
      },
      knowledgeBase: {
        tokens: knowledgeBaseTokens,
        bytes: knowledgeBaseTokens * 4,
        count: promptMeta.context?.knowledgeBaseEntries?.length || 0,
        label: 'Knowledge Base',
        color: '39', // Blue
        duplicates: 0,
      },
      projectContext: {
        tokens: otherTokens,
        bytes: otherTokens * 4,
        count: 0,
        label: 'Project & Tools',
        color: '208', // Orange
        duplicates: 0,
      },
      output: {
        tokens: actualOutputTokens,
        bytes: actualOutputTokens * 4,
        count: promptMeta.replyIds?.length || 1,
        label: 'Model Output',
        color: '82', // Green
        duplicates: 0,
      },
    };

    const totalUsed = actualInputTokens + actualOutputTokens;
    const freeSpace = contextWindow - totalUsed;
    const usagePercent = (totalUsed / contextWindow) * 100;

    return {
      breakdown,
      totalUsed,
      freeSpace,
      contextWindow,
      usagePercent,
      maxOutputTokens,
      inputTokens: actualInputTokens,
      outputTokens: actualOutputTokens,
      modelInfo,
    };
  }, [promptMeta, modelInfoRepo]);

  // Generate ASCII art boxes (each box = 10k tokens or 40KB)
  const generateBoxes = (mode: ViewMode) => {
    const boxes: string[] = [];
    const boxSize = mode === 'tokens' ? 10000 : 40000; // 10k tokens or 40KB per box
    const total = mode === 'tokens' ? contextData.contextWindow : contextData.contextWindow * 4; // bytes
    const used = mode === 'tokens' ? contextData.totalUsed : contextData.totalUsed * 4;

    // Calculate number of boxes needed (minimum 1, maximum reasonable limit)
    const numBoxes = Math.min(Math.max(1, Math.ceil(total / boxSize)), 30); // Cap at 30 boxes for huge contexts

    let remainingUsed = used;

    for (let i = 0; i < numBoxes; i++) {
      if (remainingUsed >= boxSize) {
        boxes.push('⛁'); // Filled box
        remainingUsed -= boxSize;
      } else if (remainingUsed > boxSize * 0.5) {
        boxes.push('⛀'); // Partially filled (more than half)
        remainingUsed = 0;
      } else if (remainingUsed > 0) {
        boxes.push('⛷'); // Partially filled (less than half) - using different symbol for granularity
        remainingUsed = 0;
      } else {
        boxes.push('⛶'); // Empty
      }
    }

    return boxes;
  };

  // Format number with appropriate units
  const formatValue = (value: number, mode: ViewMode): string => {
    if (mode === 'tokens') {
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
      return value.toString();
    } else {
      // Bytes
      if (value >= 1073741824) return `${(value / 1073741824).toFixed(1)}GB`;
      if (value >= 1048576) return `${(value / 1048576).toFixed(1)}MB`;
      if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
      return `${value}B`;
    }
  };

  const boxes = generateBoxes(viewMode);
  const modelName = contextData.modelInfo?.name || promptMeta.model?.name || 'Unknown Model';
  const contextLimit = viewMode === 'tokens' ? contextData.contextWindow : contextData.contextWindow * 4;
  const totalUsed = viewMode === 'tokens' ? contextData.totalUsed : contextData.totalUsed * 4;

  return (
    <Box sx={{ fontFamily: 'monospace', fontSize: '13px', lineHeight: 1.6 }}>
      {/* Mode Toggle */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button
          size="sm"
          variant={viewMode === 'tokens' ? 'solid' : 'outlined'}
          onClick={() => setViewMode('tokens')}
          sx={{ mr: 1 }}
        >
          Tokens
        </Button>
        <Button size="sm" variant={viewMode === 'bytes' ? 'solid' : 'outlined'} onClick={() => setViewMode('bytes')}>
          Bytes
        </Button>
      </Stack>

      {/* ASCII Art Visualization */}
      <Box sx={{ mb: 2 }}>
        {/* Display boxes in rows of 10 for readability */}
        {(() => {
          const boxesPerRow = 10;
          const rows = [];
          for (let i = 0; i < boxes.length; i += boxesPerRow) {
            rows.push(boxes.slice(i, i + boxesPerRow));
          }

          return (
            <>
              {/* Context title and info */}
              <Typography sx={{ fontFamily: 'monospace', mb: 0.5, fontWeight: 'bold' }}>
                Context Usage
                <Box component="span" sx={{ ml: 2, opacity: 0.7, fontWeight: 'normal' }}>
                  {modelName} • {formatValue(totalUsed, viewMode)}/{formatValue(contextLimit, viewMode)} {viewMode} (
                  {contextData.usagePercent.toFixed(1)}%)
                </Box>
              </Typography>

              {/* Box grid with colored segments */}
              {rows.map((row, rowIndex) => (
                <Typography key={rowIndex} sx={{ fontFamily: 'monospace', mb: 0.3 }}>
                  {row.map((box, boxIndex) => {
                    const absoluteIndex = rowIndex * boxesPerRow + boxIndex;

                    // Color coding based on position and fill status
                    let color = '#9c9c9c'; // Default gray for empty
                    if (box === '⛁') {
                      // Filled boxes - gradient from blue to yellow to red based on usage
                      if (absoluteIndex < boxes.length * 0.5)
                        color = '#52c41a'; // Green for low usage
                      else if (absoluteIndex < boxes.length * 0.75)
                        color = '#faad14'; // Yellow for medium
                      else color = '#ff4d4f'; // Red for high usage
                    } else if (box === '⛀' || box === '⛷') {
                      color = '#1890ff'; // Blue for partial
                    }

                    return (
                      <span key={boxIndex} style={{ color }}>
                        {box}
                        {boxIndex < row.length - 1 ? ' ' : ''}
                      </span>
                    );
                  })}
                  {/* Add box count indicator at end of first row */}
                  {rowIndex === 0 && (
                    <Box component="span" sx={{ ml: 2, opacity: 0.5, fontSize: '12px' }}>
                      {boxes.length} × 10k {viewMode === 'tokens' ? 'tokens' : 'bytes'} ={' '}
                      {formatValue(contextLimit, viewMode)}
                    </Box>
                  )}
                </Typography>
              ))}

              {/* Legend if we have multiple symbols */}
              {boxes.some(b => b === '⛷') && (
                <Typography sx={{ fontFamily: 'monospace', mt: 0.5, mb: 0.5, fontSize: '11px', opacity: 0.6 }}>
                  ⛁ = 10k+ {viewMode === 'tokens' ? 'tokens' : 'bytes'} • ⛀ = 5k-10k • ⛷ = &lt;5k • ⛶ = empty
                </Typography>
              )}
            </>
          );
        })()}

        {/* Divider */}
        <Typography sx={{ fontFamily: 'monospace', mb: 0.5, mt: 1, color: '#9c9c9c', fontSize: '12px' }}>
          {'─'.repeat(60)}
        </Typography>

        {/* Component breakdown */}
        <Box sx={{ mt: 1 }}>
          {Object.entries(contextData.breakdown).map(([key, data]) => {
            const value = viewMode === 'tokens' ? data.tokens : data.bytes;
            const percent =
              (value / (viewMode === 'tokens' ? contextData.contextWindow : contextData.contextWindow * 4)) * 100;

            if (value === 0) return null;

            // Generate mini bar for this component (max 10 chars wide)
            const barWidth = Math.ceil((percent / 100) * 10);
            const bar = '█'.repeat(Math.max(0, barWidth)).padEnd(10, '░');

            return (
              <Typography key={key} sx={{ fontFamily: 'monospace', mb: 0.4, fontSize: '12px' }}>
                <Box component="span" sx={{ color: '#6b7280', display: 'inline-block', width: '90px' }}>
                  {bar}
                </Box>
                <Box component="span" sx={{ ml: 1 }}>
                  {data.label}:
                  <Box component="span" sx={{ opacity: 0.7, ml: 1 }}>
                    {formatValue(value, viewMode)} ({percent.toFixed(1)}%)
                    {data.count > 0 && ` • ${data.count} items`}
                    {data.duplicates > 0 && (
                      <Box component="span" sx={{ color: '#faad14' }}>
                        {` • ⚠ ${data.duplicates} duplicates`}
                      </Box>
                    )}
                  </Box>
                </Box>
              </Typography>
            );
          })}

          {/* Free space */}
          <Typography sx={{ fontFamily: 'monospace', mb: 0.4, fontSize: '12px' }}>
            <Box component="span" sx={{ color: '#6b7280', display: 'inline-block', width: '90px' }}>
              {'░'.repeat(10)}
            </Box>
            <Box component="span" sx={{ ml: 1 }}>
              Free space:
              <Box component="span" sx={{ opacity: 0.7, ml: 1 }}>
                {formatValue(viewMode === 'tokens' ? contextData.freeSpace : contextData.freeSpace * 4, viewMode)} (
                {((contextData.freeSpace / contextData.contextWindow) * 100).toFixed(1)}%)
              </Box>
            </Box>
          </Typography>
        </Box>
      </Box>

      {/* Detailed breakdown section */}
      <Box sx={{ mt: 3 }}>
        <Typography sx={{ fontFamily: 'monospace', fontWeight: 'bold', mb: 1 }}>
          Context Sources
          <Box component="span" sx={{ opacity: 0.5, fontWeight: 'normal', ml: 1 }}>
            · {viewMode === 'tokens' ? 'token' : 'byte'} allocation
          </Box>
        </Typography>

        {/* Tree view of sources */}
        <Box sx={{ pl: 1 }}>
          {promptMeta.context?.systemPromptSources && promptMeta.context.systemPromptSources.length > 0 && (
            <Typography sx={{ fontFamily: 'monospace', mb: 0.5, opacity: 0.8 }}>
              ├ System Prompts ({promptMeta.context.systemPromptSources.length}):
              <Box component="span" sx={{ opacity: 0.6, ml: 1 }}>
                {(promptMeta.context.duplicateSystemPromptCount ?? 0) > 0 &&
                  `⚠ ${promptMeta.context.duplicateSystemPromptCount} duplicates`}
              </Box>
            </Typography>
          )}

          {promptMeta.context?.attachedFiles && promptMeta.context.attachedFiles.length > 0 && (
            <Typography sx={{ fontFamily: 'monospace', mb: 0.5, opacity: 0.8 }}>
              ├ Attached Files ({promptMeta.context.attachedFiles.length}):
              <Box component="span" sx={{ opacity: 0.6, ml: 1 }}>
                {formatValue(
                  viewMode === 'tokens'
                    ? contextData.breakdown.attachedFiles.tokens
                    : contextData.breakdown.attachedFiles.bytes,
                  viewMode
                )}
              </Box>
            </Typography>
          )}

          {promptMeta.context?.mementoCount && promptMeta.context.mementoCount > 0 && (
            <Typography sx={{ fontFamily: 'monospace', mb: 0.5, opacity: 0.8 }}>
              ├ Mementos RAG ({promptMeta.context.mementoCount}):
              <Box component="span" sx={{ opacity: 0.6, ml: 1 }}>
                {formatValue(
                  viewMode === 'tokens' ? contextData.breakdown.mementos.tokens : contextData.breakdown.mementos.bytes,
                  viewMode
                )}
              </Box>
            </Typography>
          )}

          {promptMeta.context?.knowledgeBaseEntries && promptMeta.context.knowledgeBaseEntries.length > 0 && (
            <Typography sx={{ fontFamily: 'monospace', mb: 0.5, opacity: 0.8 }}>
              └ Knowledge Base ({promptMeta.context.knowledgeBaseEntries.length}):
              <Box component="span" sx={{ opacity: 0.6, ml: 1 }}>
                {formatValue(
                  viewMode === 'tokens'
                    ? contextData.breakdown.knowledgeBase.tokens
                    : contextData.breakdown.knowledgeBase.bytes,
                  viewMode
                )}
              </Box>
            </Typography>
          )}
        </Box>
      </Box>

      {/* Warnings */}
      {contextData.usagePercent > 80 && (
        <Box sx={{ mt: 2, p: 1, backgroundColor: 'warning.softBg', borderRadius: 1 }}>
          <Typography sx={{ fontFamily: 'monospace', color: 'warning.plainColor', fontSize: '12px' }}>
            ⚠ High context usage ({contextData.usagePercent.toFixed(1)}%) - Consider reducing history or attachments
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default ContextVisualizer;
