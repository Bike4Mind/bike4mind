import React, { useEffect, useMemo, useState } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip, Divider } from '@mui/joy';
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
import { useSelectedArtifactContentSync } from '@client/app/hooks/useSelectedArtifactContentSync';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
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

  // The card's body is shown by default - a collapsed card used to render a 3-line,
  // 120-character sliver that identified nothing. Bounding is the truncation's job now.
  const [isExpanded, setIsExpanded] = useState(true);
  // Separate from `isExpanded`: the chevron folds the whole card to its header, this
  // reveals the rest of a truncated body in place.
  const [showFullBody, setShowFullBody] = useState(false);

  // Same contract as the reply-level Show More (useContentTruncation): cut on a line
  // boundary at the user's own `maxVisibleLines`, and honour their auto-collapse switch
  // rather than inventing a second, private rule for artifacts.
  const { settings } = useUserSettings();
  const codeLines = useMemo(() => data.code.split('\n'), [data.code]);
  const needsTruncation = settings.autoCollapseContent && codeLines.length > settings.maxVisibleLines;
  const visibleCode = useMemo(
    () => (needsTruncation && !showFullBody ? codeLines.slice(0, settings.maxVisibleLines).join('\n') : data.code),
    [needsTruncation, showFullBody, codeLines, settings.maxVisibleLines, data.code]
  );

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

  // Propagate live content changes to the Knowledge Base without letting a scroll-driven
  // (re)mount of a same-id card clobber the newest version - see the hook for the #457 detail.
  useSelectedArtifactContentSync(artifactId, 'code', data.code, data);

  return (
    <Card
      className="code-artifact-preview-card"
      variant="outlined"
      sx={theme => ({
        // Matches ArtifactPreviewCard: the sidebar/header surface, not Joy's undefined
        // background.level1 default.
        backgroundColor: 'background.surface2',
        // The same veil ArtifactPreviewCard and a fenced code block carry, so a code
        // card sits in the same family as every other artifact rather than reading as
        // a flat panel. backgroundImage, not a background shorthand, so the fill above
        // still resolves per color scheme.
        backgroundImage: `linear-gradient(180deg, ${theme.palette.reading.cardTintTop}, ${theme.palette.reading.cardTintBottom})`,
        borderRadius: '8px',
        position: 'relative',
        overflow: 'visible',
        borderWidth: 1,
        borderColor: isSelected ? 'primary.500' : theme.palette.reading.cardLine,
        transition: 'all 0.2s ease-in-out',
        cursor: 'pointer',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: 'sm',
          cursor: 'pointer',
        },
      })}
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
        {/* Title and line count are one block, so the trailing controls centre against the
            pair rather than against the title alone. Every control sits at that trailing
            edge, with the fold chevron last behind a rule - it acts on the whole card, the
            others act on its content. Matches ArtifactPreviewCard - keep the two in sync. */}
        <Stack className="code-artifact-header" direction="row" spacing={1} alignItems="center">
          <Stack sx={{ minWidth: 0 }}>
            <Typography
              className="code-artifact-title"
              level="title-sm"
              sx={{
                color: 'text.primary',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {data.title}
            </Typography>
            {/* Stays outside the fold: with no body showing, the line count is part of what
                identifies a collapsed card. */}
            <Typography className="code-artifact-stats" level="body-xs" sx={{ color: 'text.tertiary' }}>
              {data.lineCount} lines of code
            </Typography>
          </Stack>

          <Box sx={{ flex: 1 }} />

          {/* One block so the controls space and shrink together. Matches
              ArtifactPreviewCard - keep the two in sync. */}
          <Box
            className="code-artifact-actions"
            sx={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}
          >
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

            <Divider orientation="vertical" sx={{ height: '16px', alignSelf: 'center' }} />

            <Tooltip title={isExpanded ? 'Collapse' : 'Expand'} placement="top">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                sx={actionButtonSx}
                onClick={handleToggleExpand}
                data-testid="code-artifact-toggle-btn"
              >
                {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
            </Tooltip>
          </Box>
        </Stack>

        {/* The chevron folds everything below the header away - a collapsed card is its
            header alone (type pill, title, line count), which identifies the artifact
            better than the sliver of body it used to show. */}
        {!isExpanded ? null : !isContentReady ? (
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
            {/* Code body. No inner scroller: a second scrolling surface inside the
                transcript traps the wheel as the pointer crosses it, and a fixed 400px
                window made every card claim the same height whatever it held. The page
                is the only scroller; length is bounded by truncation instead. */}
            <Box
              sx={{
                mt: 2,
                borderRadius: 'sm',
                position: 'relative',
                '& pre': { margin: '0 !important', borderRadius: '4px' },
              }}
            >
              <SyntaxHighlighter
                style={oneDark}
                language={data.language || 'text'}
                customStyle={{ margin: 0, fontSize: '14px', lineHeight: 1.4, padding: '8px' }}
                wrapLongLines
              >
                {visibleCode}
              </SyntaxHighlighter>
              {/* Fade over the last rows, so the cut reads as "continues" rather than
                  as the end of the file. Non-interactive so it can't eat a text selection. */}
              {needsTruncation && !showFullBody && (
                <Box
                  sx={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: '48px',
                    pointerEvents: 'none',
                    borderRadius: '0 0 4px 4px',
                    background: `linear-gradient(180deg, transparent, ${oneDark['pre[class*="language-"]']?.background ?? 'rgba(0,0,0,0.6)'})`,
                  }}
                />
              )}
            </Box>

            {needsTruncation && (
              <Typography
                component="button"
                type="button"
                level="body-sm"
                data-testid="code-artifact-show-more-btn"
                onClick={e => {
                  e.stopPropagation();
                  setShowFullBody(v => !v);
                }}
                sx={{
                  mt: '16px',
                  p: 0,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'text.primary',
                  fontWeight: 500,
                  '&:hover': { textDecoration: 'underline' },
                }}
              >
                {showFullBody ? 'Show less' : `Show ${codeLines.length - settings.maxVisibleLines} more lines`}
              </Typography>
            )}
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
