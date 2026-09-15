import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  Stack,
  Grid,
  Chip,
  IconButton,
  Tooltip,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Accordion,
  AccordionGroup,
  AccordionSummary,
  AccordionDetails,
  Button,
  Sheet,
} from '@mui/joy';
import {
  GridView as GridIcon,
  ViewList as TabsIcon,
  UnfoldMore as AccordionIcon,
  ContentCopy as CopyIcon,
  Download as ExportIcon,
  Sync as SyncIcon,
  SyncDisabled as SyncDisabledIcon,
  Speed as MetricsIcon,
  CheckCircle as CheckCircleIcon,
  RadioButtonUnchecked as UncheckedIcon,
} from '@mui/icons-material';
import { IChatHistoryItem } from '@bike4mind/common';
import PromptReplies from './PromptReplies';
import ThoughtBubbles from './ThoughtBubbles';
import { ResearchModeConfiguration } from '../../types/ResearchMode';
// import { useUserSettings } from '../../contexts/UserSettingsContext'; // Future use
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { toast } from 'sonner';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { extractThinking } from '@client/app/utils/replyUtils';

interface ResearchModeResult {
  configurationId: string;
  success: boolean;
  response?: string;
  error?: string;
  completionInfo?: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface ResearchModeResponseDisplayProps {
  quest: IChatHistoryItem;
  configurations: ResearchModeConfiguration[];
  results: ResearchModeResult[];
  streamingResults?: Map<string, string>; // Real-time streaming data
  onExport?: (results: ResearchModeResult[]) => void;
  onSelectResponse?: (
    configId: string,
    response: string,
    modelInfo: { model: string; label?: string }
  ) => Promise<void>;
  onDeselectResponse?: () => Promise<void>; // Callback to deselect current response
  selectedConfigId?: string; // Track which response was selected
  onUseModel?: (config: ResearchModeConfiguration) => void; // Callback to adopt model settings
}

type ViewMode = 'grid' | 'tabs' | 'accordion';

export const ResearchModeResponseDisplay: React.FC<ResearchModeResponseDisplayProps> = ({
  quest,
  configurations,
  results,
  streamingResults: initialStreamingResults,
  onExport,
  onSelectResponse,
  onDeselectResponse,
  selectedConfigId,
  onUseModel,
}) => {
  // const { settings } = useUserSettings(); // Future use for user preferences
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [syncScrolling, setSyncScrolling] = useState(true);
  const [showMetrics, setShowMetrics] = useState(false);
  const [streamingResults, setStreamingResults] = useState<Map<string, string>>(initialStreamingResults || new Map());
  const [isSelecting, setIsSelecting] = useState(false); // Track selection state
  const [loadingConfigId, setLoadingConfigId] = useState<string | null>(null); // Track which response is being processed
  // Use quest ID to ensure scroll containers are unique per quest
  const scrollContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const { handleCopyToClipboard } = useCopyToClipboard();

  // Filter results to only include those with actual data
  const validResults = results || [];

  // Listen for Research Mode streaming updates
  useEffect(() => {
    const handleResearchModeStream = (event: CustomEvent) => {
      const { questId, configurationId, streamedTexts } = event.detail;

      // Only process events for this specific quest

      if (questId === quest.id && configurationId) {
        setStreamingResults(prev => {
          const newResults = new Map(prev);
          const currentText = newResults.get(configurationId) || '';
          const newText = streamedTexts?.join('') || '';
          newResults.set(configurationId, currentText + newText);
          return newResults;
        });
      }
    };

    window.addEventListener('research-mode-stream', handleResearchModeStream as EventListener);

    return () => {
      window.removeEventListener('research-mode-stream', handleResearchModeStream as EventListener);
    };
  }, [quest.id]);

  // Sync scrolling across all response containers (only for this quest)
  const handleScroll = useCallback(
    (configId: string, event: React.UIEvent<HTMLDivElement>) => {
      if (!syncScrolling) return;

      const scrollTop = event.currentTarget.scrollTop;
      const scrollLeft = event.currentTarget.scrollLeft;

      scrollContainerRefs.current.forEach((container, id) => {
        if (id !== configId && container && id.startsWith(`${quest.id}-`)) {
          container.scrollTop = scrollTop;
          container.scrollLeft = scrollLeft;
        }
      });
    },
    [syncScrolling, quest.id]
  );

  // Get configuration info by ID - fallback to result data if config not found
  const getConfigInfo = (configId: string) => {
    const config = configurations.find(config => config.id === configId);
    if (config) return config;

    // If config not found (e.g., it was deleted), create a minimal config from result
    const result = validResults.find(r => r.configurationId === configId);
    if (result) {
      // Fallback for when configurations change between prompts
      return {
        id: configId,
        enabled: true,
        model: 'gpt-4' as any, // Fallback model when config is missing
        label: `Config ${configId.slice(0, 8)}`,
        parameters: {},
      } as ResearchModeConfiguration;
    }
    return null;
  };

  // Get result by configuration ID
  const getResult = (configId: string) => {
    return results.find(result => result.configurationId === configId);
  };

  // Get streaming response for configuration
  const getStreamingResponse = (configId: string) => {
    return streamingResults?.get(configId) || '';
  };

  const calculateMetrics = () => {
    const totalInputTokens = results.reduce((sum, result) => sum + (result.completionInfo?.inputTokens || 0), 0);
    const totalOutputTokens = results.reduce((sum, result) => sum + (result.completionInfo?.outputTokens || 0), 0);
    const successCount = results.filter(result => result.success).length;
    const errorCount = results.filter(result => !result.success).length;

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      successCount,
      errorCount,
      configurations: results.length,
    };
  };

  // Export comparison results
  const handleExport = () => {
    const exportData = {
      quest: {
        id: quest.id,
        prompt: quest.prompt,
        timestamp: quest.timestamp,
      },
      configurations: configurations.map(config => ({
        id: config.id,
        label: config.label || config.model,
        model: config.model,
        parameters: config.parameters,
      })),
      results: results.map(result => ({
        configurationId: result.configurationId,
        configuration: getConfigInfo(result.configurationId),
        success: result.success,
        response: result.response,
        error: result.error,
        metrics: result.completionInfo,
      })),
      metrics: calculateMetrics(),
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `research-mode-comparison-${quest.id}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success('Research Mode comparison exported successfully');
    onExport?.(results);
  };

  // Copy all responses to clipboard
  const handleCopyAll = () => {
    const allResponses = results
      .map(result => {
        const config = getConfigInfo(result.configurationId);
        const header = `## ${config?.label || config?.model || 'Unknown Model'}`;
        const content = result.success ? result.response : `Error: ${result.error}`;
        return `${header}\n\n${content}`;
      })
      .join('\n\n---\n\n');

    handleCopyToClipboard(allResponses);
    toast.success('All responses copied to clipboard');
  };

  // Render response content for a configuration
  const renderResponseContent = (configId: string, className?: string) => {
    const config = getConfigInfo(configId);
    const result = getResult(configId);
    const streamingText = getStreamingResponse(configId);

    if (!config) return null;

    // Extract thinking content from the response
    const originalResponse = result?.response || streamingText || '';
    const thinkingContent = extractThinking({ reply: originalResponse });

    // Create a mock quest for each response to use with PromptReplies
    const responseQuest: IChatHistoryItem = {
      ...quest,
      id: `${quest.id}-${configId}`,
      reply: result?.response || streamingText || undefined,
      replies: result?.response ? [result.response] : streamingText ? [streamingText] : [],
      status: result?.success === false ? 'stopped' : streamingText ? 'running' : 'done',
    };

    return (
      <Box
        key={configId}
        className={className}
        sx={{
          height: '100%',
          overflow: 'auto',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 'sm',
          position: 'relative',
        }}
        ref={(ref: HTMLDivElement | null) => {
          if (ref) {
            scrollContainerRefs.current.set(`${quest.id}-${configId}`, ref);
          }
        }}
        onScroll={e => handleScroll(`${quest.id}-${configId}`, e)}
      >
        {/* Configuration Header */}
        <Sheet
          sx={{
            p: 2,
            borderBottom: '1px solid',
            borderColor: 'divider',
            position: 'sticky',
            top: 0,
            zIndex: 1,
            backgroundColor: 'background.surface',
          }}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography level="title-sm" fontWeight="bold">
                {config.label || config.model}
              </Typography>
              <Chip
                variant={result?.success ? 'soft' : 'outlined'}
                color={result?.success ? 'success' : 'danger'}
                size="sm"
              >
                {result?.success ? 'Success' : 'Error'}
              </Chip>
            </Stack>

            <Stack direction="row" spacing={0.5}>
              <Tooltip title="Copy response">
                <IconButton
                  size="sm"
                  variant="plain"
                  onClick={() => {
                    const text = result?.response || streamingText || result?.error || '';
                    handleCopyToClipboard(text);
                    toast.success('Response copied to clipboard');
                  }}
                >
                  <CopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>

          {/* Configuration details */}
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <Chip variant="outlined" size="sm">
              {config.model}
            </Chip>
            {config.parameters.temperature && (
              <Chip variant="outlined" size="sm">
                T: {config.parameters.temperature}
              </Chip>
            )}
            {config.parameters.maxTokens && (
              <Chip variant="outlined" size="sm">
                Max: {config.parameters.maxTokens}
              </Chip>
            )}
            {result?.completionInfo && (
              <Chip variant="outlined" size="sm" color="neutral">
                {result.completionInfo.outputTokens} tokens
              </Chip>
            )}
          </Stack>
        </Sheet>

        {/* Response Content */}
        <Box sx={{ p: 2 }}>
          {result?.success === false ? (
            <Typography color="danger" level="body-sm">
              Error: {result.error}
            </Typography>
          ) : (
            <>
              {/* Display thinking content if available - defaultFolded in research mode since there are multiple responses */}
              {thinkingContent && (
                <ThoughtBubbles content={thinkingContent} isStreaming={streamingText ? true : false} defaultFolded />
              )}

              <PromptReplies
                messageData={responseQuest}
                onSendMessage={async () => {}} // Disabled for Research Mode
                showSyntaxHighlight={true}
              />

              {/* Selection and Use Model Buttons */}
              {(onSelectResponse || onUseModel) && result?.response && (
                <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                  {onUseModel && (
                    <Tooltip title="Apply this model and its settings as your default for future prompts">
                      <Button
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        startDecorator={<SettingsIcon />}
                        onClick={() => {
                          onUseModel(config);
                          toast.success(`Now using ${config.label || config.model} as your default model`);
                        }}
                      >
                        Use This Model
                      </Button>
                    </Tooltip>
                  )}
                  {onSelectResponse && (
                    <Button
                      size="sm"
                      variant={selectedConfigId === configId ? 'solid' : 'outlined'}
                      color={selectedConfigId === configId ? 'success' : 'primary'}
                      startDecorator={selectedConfigId === configId ? <CheckCircleIcon /> : <UncheckedIcon />}
                      onClick={async () => {
                        if (loadingConfigId) return; // Prevent multiple clicks during loading

                        setLoadingConfigId(configId);

                        try {
                          if (selectedConfigId === configId) {
                            // Already selected, clicking again will deselect
                            if (onDeselectResponse) {
                              await onDeselectResponse();
                              setIsSelecting(false);
                            }
                          } else {
                            // Select this response
                            if (onSelectResponse) {
                              await onSelectResponse(configId, result.response!, {
                                model: config.model,
                                label: config.label,
                              });
                              setIsSelecting(true);
                            }
                          }
                        } catch (error) {
                          console.error('Error during selection/deselection:', error);
                        } finally {
                          setLoadingConfigId(null);
                        }
                      }}
                      disabled={loadingConfigId !== null}
                      loading={loadingConfigId === configId}
                    >
                      {loadingConfigId === configId
                        ? selectedConfigId === configId
                          ? 'Deselecting...'
                          : 'Selecting...'
                        : selectedConfigId === configId
                          ? 'Selected (click to deselect)'
                          : 'Select for Conversation'}
                    </Button>
                  )}
                </Box>
              )}
            </>
          )}
        </Box>
      </Box>
    );
  };

  const metrics = calculateMetrics();

  return (
    <Box style={{ overflow: 'auto' }}>
      {/* Control Bar */}
      <Sheet sx={{ p: 2, mb: 2, borderRadius: 'sm' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Stack direction="row" alignItems="center" spacing={2}>
            <Typography level="title-md" startDecorator="🔬">
              Research Mode Results ({validResults.length} configurations)
            </Typography>

            <Stack direction="row" spacing={1}>
              <Tooltip title="Grid View">
                <IconButton
                  size="sm"
                  variant={viewMode === 'grid' ? 'solid' : 'outlined'}
                  onClick={() => setViewMode('grid')}
                >
                  <GridIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Tab View">
                <IconButton
                  size="sm"
                  variant={viewMode === 'tabs' ? 'solid' : 'outlined'}
                  onClick={() => setViewMode('tabs')}
                >
                  <TabsIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Accordion View">
                <IconButton
                  size="sm"
                  variant={viewMode === 'accordion' ? 'solid' : 'outlined'}
                  onClick={() => setViewMode('accordion')}
                >
                  <AccordionIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Stack>

          <Stack direction="row" alignItems="center" spacing={1}>
            <Tooltip title={syncScrolling ? 'Disable synchronized scrolling' : 'Enable synchronized scrolling'}>
              <IconButton
                size="sm"
                variant={syncScrolling ? 'solid' : 'outlined'}
                color={syncScrolling ? 'primary' : 'neutral'}
                onClick={() => setSyncScrolling(!syncScrolling)}
              >
                {syncScrolling ? <SyncIcon fontSize="small" /> : <SyncDisabledIcon fontSize="small" />}
              </IconButton>
            </Tooltip>

            <Tooltip title="Show metrics">
              <IconButton
                size="sm"
                variant={showMetrics ? 'solid' : 'outlined'}
                onClick={() => setShowMetrics(!showMetrics)}
              >
                <MetricsIcon fontSize="small" />
              </IconButton>
            </Tooltip>

            <Button size="sm" startDecorator={<CopyIcon />} onClick={handleCopyAll}>
              Copy All
            </Button>

            <Button size="sm" startDecorator={<ExportIcon />} onClick={handleExport}>
              Export
            </Button>
          </Stack>
        </Stack>

        {/* Selection Mode Indicator */}
        {isSelecting && selectedConfigId && (
          <Box
            sx={{
              mt: 2,
              p: 2,
              borderRadius: 'sm',
              backgroundColor: 'success.softBg',
              border: '1px solid',
              borderColor: 'success.300',
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1}>
              <CheckCircleIcon color="success" />
              <Typography level="body-sm" color="success">
                {(() => {
                  const selectedConfig = getConfigInfo(selectedConfigId);
                  return `${selectedConfig?.label || selectedConfig?.model || 'Response'} selected. This response will be used to continue the conversation.`;
                })()}
              </Typography>
            </Stack>
          </Box>
        )}

        {/* Metrics Display */}
        {showMetrics && (
          <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Grid container spacing={2}>
              <Grid xs={6} sm={3}>
                <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                  Total Tokens
                </Typography>
                <Typography level="title-sm">{metrics.totalTokens.toLocaleString()}</Typography>
              </Grid>
              <Grid xs={6} sm={3}>
                <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                  Success Rate
                </Typography>
                <Typography level="title-sm">
                  {metrics.configurations > 0
                    ? `${Math.round((metrics.successCount / metrics.configurations) * 100)}%`
                    : '0%'}
                </Typography>
              </Grid>
              <Grid xs={6} sm={3}>
                <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                  Input Tokens
                </Typography>
                <Typography level="title-sm">{metrics.totalInputTokens.toLocaleString()}</Typography>
              </Grid>
              <Grid xs={6} sm={3}>
                <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                  Output Tokens
                </Typography>
                <Typography level="title-sm">{metrics.totalOutputTokens.toLocaleString()}</Typography>
              </Grid>
            </Grid>
          </Box>
        )}
      </Sheet>

      {/* Response Display */}
      {viewMode === 'grid' && (
        <Grid container spacing={2} sx={{ height: '600px' }}>
          {validResults.map(result => {
            const config = getConfigInfo(result.configurationId);
            if (!config) return null;
            return (
              <Grid key={result.configurationId} xs={12} sm={6} lg={validResults.length > 2 ? 6 : 12}>
                {renderResponseContent(result.configurationId)}
              </Grid>
            );
          })}
        </Grid>
      )}

      {viewMode === 'tabs' && (
        <Tabs defaultValue={validResults[0]?.configurationId}>
          <TabList>
            {validResults.map(result => {
              const config = getConfigInfo(result.configurationId);
              if (!config) return null;
              return (
                <Tab
                  key={result.configurationId}
                  value={result.configurationId}
                  color={result.success ? 'primary' : 'danger'}
                >
                  {config.label || config.model}
                  {result.completionInfo && (
                    <Chip size="sm" variant="soft" sx={{ ml: 1 }}>
                      {result.completionInfo.outputTokens}
                    </Chip>
                  )}
                </Tab>
              );
            })}
          </TabList>
          {validResults.map(result => {
            const config = getConfigInfo(result.configurationId);
            if (!config) return null;
            return (
              <TabPanel key={result.configurationId} value={result.configurationId} sx={{ p: 0, mt: 2 }}>
                <Box sx={{ height: '600px' }}>{renderResponseContent(result.configurationId)}</Box>
              </TabPanel>
            );
          })}
        </Tabs>
      )}

      {viewMode === 'accordion' && (
        <AccordionGroup>
          {validResults.map((result, index) => {
            const config = getConfigInfo(result.configurationId);
            if (!config) return null;
            return (
              <Accordion key={result.configurationId} defaultExpanded={index === 0}>
                <AccordionSummary>
                  <Stack direction="row" alignItems="center" spacing={2} sx={{ width: '100%' }}>
                    <Typography level="title-sm">{config.label || config.model}</Typography>
                    <Chip variant="soft" color={result.success ? 'success' : 'danger'} size="sm">
                      {result.success ? 'Success' : 'Error'}
                    </Chip>
                    {result.completionInfo && (
                      <Chip variant="outlined" size="sm">
                        {result.completionInfo.outputTokens} tokens
                      </Chip>
                    )}
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  <Box sx={{ height: '400px' }}>{renderResponseContent(result.configurationId)}</Box>
                </AccordionDetails>
              </Accordion>
            );
          })}
        </AccordionGroup>
      )}
    </Box>
  );
};

export default ResearchModeResponseDisplay;
