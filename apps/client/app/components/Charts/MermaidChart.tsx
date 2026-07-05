import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { Box, IconButton, Stack, Tab, TabList, TabPanel, Tabs, Typography, useTheme, Textarea } from '@mui/joy';
import { Code, Download, ContentCopy } from '@mui/icons-material';
import ErrorIcon from '@mui/icons-material/Error';
import { useSnackbar } from '@client/app/contexts/SnackbarContext';

interface MermaidChartProps {
  chartDefinition: string;
  title?: string;
  description?: string;
  onChartChange?: (newDefinition: string) => void;
  readOnly?: boolean;
  className?: string;
}

const MermaidChart: React.FC<MermaidChartProps> = ({
  chartDefinition,
  title,
  description,
  onChartChange,
  readOnly = true,
  className,
}) => {
  const theme = useTheme();
  const { showSnackbar } = useSnackbar();
  const elementRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chart' | 'source'>('chart');
  const [localDefinition, setLocalDefinition] = useState(chartDefinition);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: true,
      theme: theme.palette.mode === 'dark' ? 'dark' : 'default',
      securityLevel: 'loose', // Required for PNG export
    });
  }, [theme.palette.mode]);

  // Render chart when definition changes, tab changes, or container becomes visible
  useEffect(() => {
    if (activeTab !== 'chart' || !elementRef.current) return;

    let cancelled = false;
    const container = elementRef.current;

    const renderChart = async () => {
      if (cancelled || !elementRef.current) return;
      // Don't render into a zero-size container - wait for ResizeObserver to retry
      if (elementRef.current.offsetWidth === 0 && typeof process !== 'undefined' && process.env.NODE_ENV !== 'test')
        return;
      try {
        setError(null);
        const { svg } = await mermaid.render('mermaid-chart', localDefinition);
        if (cancelled || !elementRef.current) return;

        elementRef.current.innerHTML = '';

        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
        const svgElement = svgDoc.documentElement;

        const originalWidth = svgElement.getAttribute('width');
        const originalHeight = svgElement.getAttribute('height');

        if (!svgElement.getAttribute('viewBox') && originalWidth && originalHeight) {
          svgElement.setAttribute('viewBox', `0 0 ${originalWidth} ${originalHeight}`);
        }

        svgElement.setAttribute('width', '100%');
        svgElement.setAttribute('height', '100%');
        svgElement.style.maxWidth = '100%';
        svgElement.style.maxHeight = '100%';
        svgElement.style.display = 'block';
        svgElement.style.margin = '0 auto';

        elementRef.current.appendChild(svgElement);
      } catch (err) {
        console.error('Mermaid chart rendering error:', err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to render chart');
      }
    };

    renderChart();

    // Re-render when the container gains size (e.g. inside a collapsed panel or modal)
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && !container.querySelector('svg')) {
        renderChart();
      }
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [theme.palette.mode, localDefinition, activeTab]);

  const handleDefinitionChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newDefinition = event.target.value;
    setLocalDefinition(newDefinition);
    onChartChange?.(newDefinition);
  };

  const handleCopyDefinition = async () => {
    try {
      await navigator.clipboard.writeText(localDefinition);
      showSnackbar('Chart definition copied to clipboard', { variant: 'plain' });
    } catch (err) {
      showSnackbar('Failed to copy chart definition', { variant: 'soft' });
    }
  };

  // Copy chart as PNG (Chart tab) or copy source code (Source tab)
  const handleCopy = async () => {
    if (activeTab === 'source') {
      return handleCopyDefinition();
    }

    if (!elementRef.current) return;
    try {
      const svgElement = elementRef.current.querySelector('svg');
      if (!svgElement) throw new Error('SVG element not found');

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');

      const svgData = new XMLSerializer().serializeToString(svgElement);
      const img = new window.Image();

      const blob = await new Promise<Blob>((resolve, reject) => {
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to create blob'));
          }, 'image/png');
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
      });

      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
      showSnackbar('Chart copied as PNG', { variant: 'plain' });
    } catch (err) {
      console.error('PNG copy error:', err);
      showSnackbar('Failed to copy chart as PNG', { variant: 'soft' });
    }
  };

  const handleExportPNG = async () => {
    if (!elementRef.current) return;
    try {
      const svgElement = elementRef.current.querySelector('svg');
      if (!svgElement) throw new Error('SVG element not found');

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');

      const svgData = new XMLSerializer().serializeToString(svgElement);
      const img = new window.Image();

      const blob = await new Promise<Blob>((resolve, reject) => {
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('Failed to create blob'));
          }, 'image/png');
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title || 'mermaid-chart'}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showSnackbar('Chart exported as PNG', { variant: 'plain' });
    } catch (err) {
      console.error('PNG export error:', err);
      showSnackbar('Failed to export chart as PNG', { variant: 'soft' });
    }
  };

  return (
    <Stack spacing={2} sx={{ width: '100%', height: '100%' }} className={className}>
      {/* Title and Description */}
      {(title || description) && (
        <Box>
          {title && <Typography level="h4">{title}</Typography>}
          {description && (
            <Typography level="body-sm" color="neutral">
              {description}
            </Typography>
          )}
        </Box>
      )}

      {/* Chart/Source Tabs */}
      <Tabs
        value={activeTab}
        onChange={(_, v) => setActiveTab(v as 'chart' | 'source')}
        sx={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
          <TabList>
            <Tab value="chart" data-testid="mermaid-chart-tab">
              Chart
            </Tab>
            <Tab value="source" data-testid="mermaid-source-tab">
              Source
            </Tab>
          </TabList>

          {/* Actions */}
          <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
            <IconButton
              size="sm"
              variant="soft"
              onClick={handleCopyDefinition}
              title="Copy chart definition"
              data-testid="mermaid-copy-definition-btn"
            >
              <Code />
            </IconButton>
            <IconButton
              size="sm"
              variant="soft"
              onClick={handleCopy}
              title={activeTab === 'source' ? 'Copy source code' : 'Copy as PNG'}
              data-testid="mermaid-copy-btn"
            >
              <ContentCopy />
            </IconButton>
            <IconButton
              size="sm"
              variant="soft"
              onClick={handleExportPNG}
              title="Download as PNG"
              data-testid="mermaid-download-btn"
            >
              <Download />
            </IconButton>
          </Box>
        </Box>

        <TabPanel value="chart" sx={{ flex: 1, overflow: 'hidden', p: 1, height: 0 }}>
          {error ? (
            <Stack
              spacing={2}
              alignItems="center"
              sx={{ p: 2, bgcolor: 'background.level1', borderRadius: 'sm' }}
              data-testid="mermaid-error-display"
            >
              <ErrorIcon sx={{ color: 'danger.500' }} />
              <Typography sx={{ color: 'danger.500' }}>Failed to render chart:</Typography>
              <Typography level="body-sm" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                {error}
              </Typography>
            </Stack>
          ) : (
            <Box
              ref={elementRef}
              data-testid="mermaid-chart-container"
              sx={{
                width: '100%',
                height: '100%',
                maxHeight: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start',
                overflow: 'auto',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: 'sm',
                bgcolor: 'background.surface',
                position: 'relative',
              }}
            />
          )}
        </TabPanel>

        <TabPanel value="source" sx={{ flex: 1, overflow: 'auto', p: 2 }}>
          {readOnly ? (
            <Box
              component="pre"
              data-testid="mermaid-source-readonly"
              sx={{
                p: 2,
                borderRadius: 'sm',
                bgcolor: 'background.level1',
                overflow: 'auto',
                fontSize: '0.875rem',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
              }}
            >
              {localDefinition}
            </Box>
          ) : (
            <Textarea
              value={localDefinition}
              onChange={handleDefinitionChange}
              minRows={10}
              slotProps={{
                textarea: {
                  'data-testid': 'mermaid-source-textarea',
                },
              }}
              sx={{
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                width: '100%',
                height: '100%',
              }}
            />
          )}
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

export default MermaidChart;
