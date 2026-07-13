import React, { useEffect, useState } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip } from '@mui/joy';
import {
  OpenInFullOutlined as ExpandIcon,
  ContentCopyOutlined as CopyIcon,
  SaveOutlined as SaveIcon,
  ExpandMoreOutlined as ExpandMoreIcon,
  ExpandLessOutlined as ExpandLessIcon,
} from '@mui/icons-material';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter/dist/cjs';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'sonner';
import { brand } from '@client/app/utils/themes/colors';
import { actionButtonSx } from './ArtifactPreviewCard';

interface CodeArtifactData {
  title: string;
  description: string;
  language: string;
  code: string;
  lineCount: number;
}

interface CodeArtifactPreviewCardProps {
  data: CodeArtifactData;
  artifactId: string;
  onExpand?: () => void;
}

const CodeArtifactPreviewCard: React.FC<CodeArtifactPreviewCardProps> = ({ data, artifactId, onExpand }) => {
  const isSelected = useSessionLayout(s => s.selectedArtifactId) === artifactId;
  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();

  const [isExpanded, setIsExpanded] = useState(false);

  // Lazy loading for large code blocks to prevent UI freeze
  const isLargeCodeBlock = data.lineCount > 300 || data.code.length > 30000;
  const [isContentReady, setIsContentReady] = useState(!isLargeCodeBlock);

  useEffect(() => {
    if (isLargeCodeBlock && !isContentReady) {
      const callback = () => {
        setIsContentReady(true);
      };

      if ('requestIdleCallback' in window) {
        const handle = window.requestIdleCallback(callback, { timeout: 1000 });
        return () => window.cancelIdleCallback(handle);
      } else {
        const handle = setTimeout(callback, 100);
        return () => clearTimeout(handle);
      }
    }
  }, [isLargeCodeBlock, isContentReady]);

  // Toggle inline code preview (card click behavior)
  const handleToggleExpand = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  // Open in full viewer panel (dedicated button)
  const handleOpenInViewer = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSessionLayout({
      layout: 'vertical',
      artifactData: {
        type: 'code',
        content: data,
        mimeType: 'application/x-code',
        id: artifactId,
      },
      selectedArtifactId: artifactId,
    });
    onExpand?.();
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(data.code);
  };

  const handleSaveAsFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const fileName = `${data.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.${data.language}`;
      const mimeType =
        data.language === 'javascript'
          ? 'text/javascript'
          : data.language === 'typescript'
            ? 'text/typescript'
            : data.language === 'python'
              ? 'text/x-python'
              : data.language === 'html'
                ? 'text/html'
                : data.language === 'css'
                  ? 'text/css'
                  : 'text/plain';
      const file = new File([data.code], fileName, { type: mimeType });
      const fileData = {
        type: KnowledgeType.FILE,
        fileName,
        mimeType,
        fileSize: file.size,
      };
      const fabFile = await createFabFileOnServerWithUpload(fileData, file);
      const newWorkBenchFiles = [...workBenchFiles, fabFile];
      setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);
      if (currentSession) {
        const knowledgeIds = newWorkBenchFiles.map(f => f.id);
        const updatedSession = { ...currentSession, knowledgeIds };
        setCurrentSession(updatedSession);
      }
      toast.success(`Saved as ${data.language} file`);
    } catch (error) {
      console.error('Error saving file:', error);
      toast.error('Failed to save file');
    }
  };

  // Listen for selected artifact content changes and update the knowledge viewer
  useEffect(() => {
    const currentState = useSessionLayout.getState();

    // Only update if this artifact is currently selected and the content has actually changed
    if (currentState.selectedArtifactId === artifactId && currentState.artifactData?.type === 'code') {
      const currentContent = currentState.artifactData.content as CodeArtifactData;

      // Compare the actual content to avoid unnecessary updates
      if (JSON.stringify(currentContent) !== JSON.stringify(data)) {
        setSessionLayout({
          artifactData: {
            ...currentState.artifactData,
            content: data,
          },
        });
      }
    }
  }, [artifactId, data.code, data.title, data.description]);

  return (
    <Card
      className="code-artifact-preview-card"
      variant="outlined"
      sx={{
        // Matches ArtifactPreviewCard: the sidebar/header surface, not Joy's undefined
        // background.level1 default.
        backgroundColor: 'background.surface2',
        borderRadius: '8px',
        position: 'relative',
        overflow: 'visible',
        borderWidth: 1,
        borderColor: isSelected ? 'primary.500' : 'neutral.outlinedBorder',
        transition: 'all 0.2s ease-in-out',
        cursor: 'pointer',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: 'sm',
          cursor: 'pointer',
        },
      }}
      onClick={handleToggleExpand}
    >
      {/* Type badge: the language in a pill overhanging the card corner. Matches
          ArtifactPreviewCard's badge - keep the two in sync. */}
      <Chip
        className="code-artifact-icon-badge"
        size="sm"
        variant="solid"
        sx={theme => ({
          position: 'absolute',
          top: '-8px',
          left: '-8px',
          zIndex: 1,
          backgroundColor: brand[800],
          color: 'text.primary',
          border: 'none',
          paddingInline: '8px',
          '&:hover': { backgroundColor: brand[800] },
          // Light mode's text.primary is near-black and unreadable on the blue pill.
          [theme.getColorSchemeSelector('light')]: { color: '#fff' },
        })}
      >
        {data.language}
      </Chip>

      {/* Main Content */}
      {/* No padding here: the Card already provides it. */}
      <Box className="code-artifact-content">
        {/* Title leads the row so the stats line below aligns flush with it; the chevron
            follows immediately. Matches ArtifactPreviewCard - keep the two in sync. */}
        <Stack className="code-artifact-header" direction="row" spacing={1} alignItems="center">
          <Stack direction="row" alignItems="center" sx={{ minWidth: 0, gap: '4px' }}>
            <Typography
              className="code-artifact-title"
              level="title-sm"
              sx={{
                color: 'text.primary',
                // Shrink (and ellipsize) but never grow, so the chevron stays next to the text.
                flex: '0 1 auto',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {data.title}
            </Typography>

            <Tooltip title={isExpanded ? 'Collapse' : 'Expand'} placement="top">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                // Joy icons read --Icon-fontSize / --Icon-color; plain `fontSize`/`color`
                // on the button is outranked by the theme's own icon styles.
                sx={theme => ({
                  flexShrink: 0,
                  marginLeft: 0,
                  // Joy sizes IconButton from --IconButton-size; `width`/`height` alone
                  // lose to its minWidth/minHeight defaults.
                  '--IconButton-size': '24px',
                  minWidth: '24px',
                  minHeight: '24px',
                  '--Icon-fontSize': '16px',
                  '--Icon-color': theme.vars.palette.text.tertiary,
                  '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
                })}
                onClick={handleToggleExpand}
                data-testid="code-artifact-toggle-btn"
              >
                {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
            </Tooltip>
          </Stack>

          <Box sx={{ flex: 1 }} />

          <Tooltip title="Copy code to clipboard" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              sx={theme => ({ ...actionButtonSx(theme), '--Icon-fontSize': '16px' })}
              onClick={handleCopy}
            >
              <CopyIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title="Save as file to workbench" placement="top">
            <IconButton size="sm" variant="plain" color="neutral" sx={actionButtonSx} onClick={handleSaveAsFile}>
              <SaveIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title="Open in full viewer" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              sx={actionButtonSx}
              onClick={handleOpenInViewer}
              data-testid="code-artifact-expand-btn"
            >
              <ExpandIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* Loading skeleton for large code blocks */}
        {!isContentReady ? (
          <Box sx={{ mt: 2 }}>
            <Typography level="body-sm" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
              Loading large code block ({data.lineCount} lines)...
            </Typography>
            <Box
              sx={{
                mt: 1,
                height: 40,
                backgroundColor: 'neutral.100',
                borderRadius: 'sm',
                animation: 'pulse 1.5s ease-in-out infinite',
                '@keyframes pulse': {
                  '0%, 100%': { opacity: 1 },
                  '50%': { opacity: 0.5 },
                },
              }}
            />
          </Box>
        ) : (
          <>
            {/* Code Stats */}
            <Typography
              className="code-artifact-stats"
              level="body-xs"
              sx={{
                color: 'text.tertiary',
              }}
            >
              {data.lineCount} lines of code
            </Typography>

            {/* Code Preview (expandable) */}
            <Box
              sx={{
                mt: 2,
                borderRadius: 'sm',
                overflow: 'auto',
                maxHeight: isExpanded ? '400px' : '60px',
                transition: 'max-height 0.3s ease',
                '& pre': { margin: '0 !important', borderRadius: '4px' },
              }}
            >
              <SyntaxHighlighter
                style={oneDark}
                language={data.language || 'text'}
                customStyle={{ margin: 0, fontSize: '14px', lineHeight: 1.4, padding: '8px' }}
                wrapLongLines
              >
                {isExpanded
                  ? data.code
                  : `${data.code.split('\n').slice(0, 3).join('\n').substring(0, 120)}${
                      data.code.length > 120 ? '...' : ''
                    }`}
              </SyntaxHighlighter>
            </Box>
          </>
        )}
      </Box>
    </Card>
  );
};

// Memoize to skip re-renders on parent updates; the comparator handles streaming code growth.
export default React.memo(CodeArtifactPreviewCard, (prevProps, nextProps) => {
  // Return true = props equal = DON'T re-render
  // Return false = props changed = DO re-render

  // If artifactId changed, re-render (different code block selected)
  if (prevProps.artifactId !== nextProps.artifactId) return false;

  // If code length changed, re-render (handles streaming where code grows)
  if (prevProps.data.code.length !== nextProps.data.code.length) return false;

  // If title or lineCount changed, re-render
  if (prevProps.data.title !== nextProps.data.title) return false;
  if (prevProps.data.lineCount !== nextProps.data.lineCount) return false;

  // Fast content change detection: compare first/last 50 chars
  // This catches content edits without full string comparison (still O(1))
  const prevCode = prevProps.data.code;
  const nextCode = nextProps.data.code;

  if (prevCode.length > 50 || nextCode.length > 50) {
    const prevStart = prevCode.slice(0, 50);
    const nextStart = nextCode.slice(0, 50);
    const prevEnd = prevCode.slice(-50);
    const nextEnd = nextCode.slice(-50);

    if (prevStart !== nextStart || prevEnd !== nextEnd) return false;
  }

  // Everything is the same, skip re-render for performance
  return true;
});
