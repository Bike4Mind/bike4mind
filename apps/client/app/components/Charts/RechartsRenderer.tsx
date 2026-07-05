import React, { useState, useEffect } from 'react';
import { Box, Typography, Alert } from '@mui/joy';
import RechartsChart from './RechartsChart';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { tryParseChartJSON } from '@client/app/utils/chartJsonParser';

interface RechartsRendererProps {
  config: any;
  displayMode?: 'inline' | 'artifact';
  title?: string;
  description?: string;
  forceMode?: 'inline' | 'artifact'; // Override user preference
}

interface RechartsConfig {
  chartType: string;
  data: Array<Record<string, any>>;
  config: {
    xAxis?: string;
    yAxis?: string | string[]; // Support both single value and array for multiple series
    width?: number;
    height?: number;
    colors?: string[];
    legend?: boolean;
    grid?: boolean;
    tooltip?: boolean;
    responsive?: boolean;
    // ComposedChart specific configuration
    axes?: {
      x?: { dataKey: string; label?: string };
      y?: Array<{ dataKey: string; label?: string; orientation?: 'left' | 'right' }>;
    };
    children?: Array<{
      type: 'Bar' | 'Line' | 'Area';
      dataKey: string;
      fill?: string;
      stroke?: string;
      name?: string;
      [key: string]: any;
    }>;
  };
  title?: string;
  description?: string;
}

/**
 * Unified component for rendering Recharts in both inline and artifact modes
 * Handles the display logic based on user preferences and explicit overrides
 */
const RechartsRenderer: React.FC<RechartsRendererProps> = ({ config, displayMode, title, description, forceMode }) => {
  const { settings } = useUserSettings();
  const { isFeatureEnabled } = useFeatureEnabled();
  const artifactsEnabled = isFeatureEnabled('enableArtifacts');

  const [currentDisplayMode, setCurrentDisplayMode] = useState<'inline' | 'artifact'>(() => {
    if (forceMode) return forceMode;
    if (!artifactsEnabled) return 'inline';
    return displayMode || settings.rechartsDisplayMode || 'inline';
  });

  // Listen for display mode changes if no forceMode is set
  useEffect(() => {
    if (forceMode) return; // Don't react to changes if forced mode is set

    const handleDisplayModeChange = (event: CustomEvent) => {
      if (!artifactsEnabled) {
        setCurrentDisplayMode('inline');
        return;
      }
      const newMode = event.detail.displayMode as 'inline' | 'artifact';
      setCurrentDisplayMode(newMode);
    };

    window.addEventListener('rechartsDisplayModeChanged', handleDisplayModeChange as EventListener);
    return () => {
      window.removeEventListener('rechartsDisplayModeChanged', handleDisplayModeChange as EventListener);
    };
  }, [forceMode, artifactsEnabled]);

  // Update display mode when settings change
  useEffect(() => {
    if (forceMode) return;
    if (!artifactsEnabled) {
      setCurrentDisplayMode('inline');
      return;
    }
    const newMode = displayMode || settings.rechartsDisplayMode || 'inline';
    setCurrentDisplayMode(newMode);
  }, [settings.rechartsDisplayMode, artifactsEnabled, displayMode, forceMode]);

  const finalDisplayMode = currentDisplayMode;

  // Parse config if it's a string (from artifacts)
  // Uses robust JSON parser that handles LLM output issues
  let rechartsConfig: RechartsConfig;
  if (typeof config === 'string') {
    const parsed = tryParseChartJSON(config);
    if (!parsed) {
      return (
        <Box sx={{ my: 2, p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}>
          <Typography level="body-sm" color="danger">
            Error rendering chart: Could not parse chart configuration
          </Typography>
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1,
              bgcolor: 'background.level1',
              borderRadius: 'sm',
              fontSize: '0.875rem',
              fontFamily: 'monospace',
              overflow: 'auto',
              maxHeight: '200px',
            }}
          >
            {config}
          </Box>
        </Box>
      );
    }
    // Cast to local RechartsConfig interface (parser validates structure)
    rechartsConfig = {
      ...parsed,
      config: parsed.config || {},
    } as RechartsConfig;
  } else {
    rechartsConfig = {
      ...config,
      config: config.config || {},
    };
  }

  // Validate required fields
  if (!rechartsConfig.chartType || !rechartsConfig.data || !Array.isArray(rechartsConfig.data)) {
    return (
      <Alert color="warning" sx={{ m: 2 }}>
        <Typography>Invalid chart configuration: Missing chartType or data</Typography>
        <Typography level="body-xs" sx={{ mt: 1 }}>
          chartType: {rechartsConfig.chartType || 'missing'}, data:{' '}
          {Array.isArray(rechartsConfig.data)
            ? `array with ${rechartsConfig.data.length} items`
            : 'not an array or missing'}
        </Typography>
      </Alert>
    );
  }

  // Use title and description from props first, then from config
  const finalTitle = title || rechartsConfig.title;
  const finalDescription = description || rechartsConfig.description;

  // For inline mode, render directly
  if (finalDisplayMode === 'inline') {
    return (
      <Box sx={{ my: 2 }}>
        <RechartsChart config={rechartsConfig} title={finalTitle} description={finalDescription} />
      </Box>
    );
  }

  // Fallback to inline rendering
  return (
    <Box sx={{ my: 2, width: '100%' }}>
      <RechartsChart config={rechartsConfig} title={finalTitle} description={finalDescription} />
    </Box>
  );
};

export default RechartsRenderer;
