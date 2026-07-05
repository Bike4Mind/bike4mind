import React, { useEffect, useState } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip } from '@mui/joy';
import {
  Code as ReactIcon,
  OpenInFull as ExpandIcon,
  ContentCopy as CopyIcon,
  Save as SaveIcon,
  PlayArrow as PreviewIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Code as CodeViewIcon,
} from '@mui/icons-material';
import InlineArtifactPreview from './InlineArtifactPreview';
import useSessionLayout, { setSessionLayout, setSelectedArtifactVersion } from '@client/app/hooks/useSessionLayout';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'sonner';
import { type ReactArtifact } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';

interface ReactArtifactPreviewCardProps {
  artifact: ReactArtifact;
  onExpand?: () => void;
}

const getComplexityColor = (content: string): 'primary' | 'success' | 'warning' | 'danger' => {
  const lineCount = content.split('\n').length;
  if (lineCount < 50) return 'success';
  if (lineCount < 100) return 'primary';
  if (lineCount < 200) return 'warning';
  return 'danger';
};

const ReactArtifactPreviewCard: React.FC<ReactArtifactPreviewCardProps> = ({ artifact, onExpand }) => {
  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const queryClient = useQueryClient();
  const { isFeatureEnabled } = useFeatureEnabled();
  const artifactsEnabled = isFeatureEnabled('enableArtifacts');

  // Default to expanded if artifacts are disabled
  const [isExpanded, setIsExpanded] = useState(!artifactsEnabled);
  // State for showing rendered preview vs code preview
  const [showRenderedPreview, setShowRenderedPreview] = useState(false);

  // Artifact should already have complete ID from PromptReplies
  const effectiveArtifact = artifact;

  const isSelected = useSessionLayout(s => s.selectedArtifactId) === effectiveArtifact.id;

  // Toggle inline preview (card click behavior)
  const handleToggleInlinePreview = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsExpanded(true);
    setShowRenderedPreview(!showRenderedPreview);
  };

  // Open in full viewer panel (dedicated button)
  const handleOpenInViewer = (e?: React.MouseEvent) => {
    e?.stopPropagation();

    // Invalidate artifact queries to force fresh fetch from database
    queryClient.invalidateQueries({ queryKey: ['artifact', effectiveArtifact.id] });
    queryClient.invalidateQueries({ queryKey: ['artifactVersions', effectiveArtifact.id] });

    setSessionLayout({
      layout: 'vertical',
      artifactData: {
        type: 'react',
        content: effectiveArtifact,
        mimeType: 'application/vnd.ant.react',
        id: effectiveArtifact.id,
      },
      selectedArtifactId: effectiveArtifact.id,
    });
    // Open at the artifact's own latest version - clear any per-artifact selection so a
    // version chosen earlier for this artifact doesn't override the fresh open
    setSelectedArtifactVersion(effectiveArtifact.id, undefined);
    onExpand?.();
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(effectiveArtifact.content);
    toast.success('React component copied to clipboard');
  };

  const handleSaveAsFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const fileName = `${effectiveArtifact.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.tsx`;
      const file = new File([effectiveArtifact.content], fileName, { type: 'text/typescript' });
      const fileData = {
        type: KnowledgeType.FILE,
        fileName,
        mimeType: 'text/typescript',
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
      toast.success('Saved React component as TypeScript file');
    } catch (error) {
      console.error('Error saving file:', error);
      toast.error('Failed to save file');
    }
  };

  // Listen for selected artifact content changes and update the knowledge viewer
  useEffect(() => {
    const currentState = useSessionLayout.getState();

    // Only update if this artifact is currently selected and the content has actually changed
    if (currentState.selectedArtifactId === effectiveArtifact.id && currentState.artifactData?.type === 'react') {
      const currentContent = currentState.artifactData.content as ReactArtifact;

      // Compare the actual content to avoid unnecessary updates
      if (JSON.stringify(currentContent) !== JSON.stringify(effectiveArtifact)) {
        setSessionLayout({
          artifactData: {
            ...currentState.artifactData,
            content: effectiveArtifact,
          },
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveArtifact.id, effectiveArtifact.content, effectiveArtifact.metadata]);

  const dependencies = effectiveArtifact.metadata?.dependencies || [];
  const lineCount = effectiveArtifact.content.split('\n').length;
  const complexityColor = getComplexityColor(effectiveArtifact.content);

  return (
    <Card
      variant="outlined"
      sx={{
        backgroundColor: 'background.level1',
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
      onClick={handleToggleInlinePreview}
    >
      {/* React Icon Badge */}
      <Box
        sx={{
          position: 'absolute',
          top: '-8px',
          left: '-8px',
          backgroundColor: 'background.surface',
          borderRadius: '50%',
          padding: '4px',
          boxShadow: 'sm',
          zIndex: 1,
        }}
      >
        <ReactIcon color="primary" sx={{ fontSize: '16px' }} />
      </Box>

      {/* Main Content */}
      <Box sx={{ p: 1.5, pt: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" mb={1}>
          <Tooltip title={isExpanded ? 'Collapse' : 'Expand'} placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={e => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              data-testid="react-artifact-toggle-btn"
            >
              {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          </Tooltip>

          <Typography
            level="title-sm"
            sx={{
              color: 'primary.plainColor',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {effectiveArtifact.title}
          </Typography>

          <Chip size="sm" variant="soft" color={complexityColor}>
            React
          </Chip>

          <Tooltip title="Copy code to clipboard" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={handleCopy}
              data-testid="react-artifact-copy-btn"
            >
              <CopyIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title="Save as TypeScript file" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={handleSaveAsFile}
              data-testid="react-artifact-save-btn"
            >
              <SaveIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title={showRenderedPreview ? 'Show code' : 'Show preview'} placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color={showRenderedPreview ? 'primary' : 'neutral'}
              onClick={e => {
                e.stopPropagation();
                setIsExpanded(true);
                setShowRenderedPreview(!showRenderedPreview);
              }}
              data-testid="react-artifact-preview-btn"
            >
              {showRenderedPreview ? <CodeViewIcon /> : <PreviewIcon />}
            </IconButton>
          </Tooltip>

          <Tooltip title="Open in full viewer" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={handleOpenInViewer}
              data-testid="react-artifact-expand-btn"
            >
              <ExpandIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* Component Stats */}
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          <Typography
            level="body-xs"
            sx={{
              color: 'text.tertiary',
            }}
          >
            {lineCount} lines
          </Typography>

          {dependencies.length > 0 && (
            <Typography
              level="body-xs"
              sx={{
                color: 'text.tertiary',
              }}
            >
              {dependencies.length} {dependencies.length === 1 ? 'dependency' : 'dependencies'}
            </Typography>
          )}
        </Stack>

        {/* Dependencies Preview */}
        {dependencies.length > 0 && (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
            {dependencies.slice(0, 3).map((dep, index) => (
              <Chip key={index} size="sm" variant="outlined" color="neutral">
                {dep}
              </Chip>
            ))}
            {dependencies.length > 3 && (
              <Chip size="sm" variant="outlined" color="neutral">
                +{dependencies.length - 3} more
              </Chip>
            )}
          </Stack>
        )}

        {/* Component Preview (expandable) */}
        {isExpanded && showRenderedPreview ? (
          <Box sx={{ mt: 1 }} onClick={e => e.stopPropagation()}>
            <InlineArtifactPreview
              artifact={effectiveArtifact}
              type="react"
              maxHeight={400}
              onError={error => console.error('[ReactArtifactPreviewCard] Preview error:', error)}
            />
          </Box>
        ) : (
          <Box
            sx={{
              mt: 1,
              p: 1,
              borderRadius: 'sm',
              bgcolor: 'background.level2',
              fontFamily: 'monospace',
              fontSize: '11px',
              lineHeight: 1.4,
              color: 'text.secondary',
              overflow: 'auto',
              maxHeight: isExpanded ? '400px' : '60px',
              transition: 'max-height 0.3s ease',
            }}
          >
            <Typography level="body-xs" sx={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
              {isExpanded
                ? effectiveArtifact.content
                : `${effectiveArtifact.content.split('\n').slice(0, 3).join('\n').substring(0, 120)}${
                    effectiveArtifact.content.length > 120 ? '...' : ''
                  }`}
            </Typography>
          </Box>
        )}
      </Box>
    </Card>
  );
};

export default ReactArtifactPreviewCard;
