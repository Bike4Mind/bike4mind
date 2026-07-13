import React, { useEffect, useState, type ReactNode } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip, type ColorPaletteProp } from '@mui/joy';
import {
  OpenInFull as ExpandIcon,
  ContentCopy as CopyIcon,
  Save as SaveIcon,
  PlayArrow as PreviewIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Code as CodeViewIcon,
} from '@mui/icons-material';
import useSessionLayout, { setSessionLayout, setSelectedArtifactVersion } from '@client/app/hooks/useSessionLayout';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';

/** Chip color by source size. Shared so every type grades complexity on the same scale. */
export const getComplexityColor = (content: string): ColorPaletteProp => {
  const lineCount = content.split('\n').length;
  if (lineCount < 50) return 'success';
  if (lineCount < 100) return 'primary';
  if (lineCount < 200) return 'warning';
  return 'danger';
};

export interface ArtifactSaveFile {
  fileName: string;
  mimeType: string;
  successMessage: string;
}

export interface ArtifactPreviewCardProps {
  artifactId: string;
  /** Discriminant on sessionLayout.artifactData; selects the side-panel viewer. */
  artifactType: string;
  mimeType: string;
  /** Payload handed to the side-panel viewer. */
  artifactContent: unknown;
  title: string;
  /** Badge glyph pinned to the card corner. Size it at 16px to match its siblings. */
  icon: ReactNode;
  chipLabel: ReactNode;
  chipColor?: ColorPaletteProp;
  /** Row under the header: line counts, data points, dependencies. */
  stats?: ReactNode;
  /** Block between stats and body, e.g. React's dependency chips. */
  extra?: ReactNode;
  testIdPrefix: string;
  /**
   * Raw text backing copy, save and the source view. Omit for types whose "source" is
   * machine plumbing the user never asked for (a chart's JSON config), which also
   * collapses the card body down to the live render alone.
   */
  source?: string;
  copyTooltip?: string;
  copyMessage?: string;
  saveTooltip?: string;
  /** Called at save time, not render time -- filenames are timestamped. */
  saveFile?: () => ArtifactSaveFile;
  /** Live render shown when expanded. Omit for types with no lightweight inline renderer. */
  renderPreview?: () => ReactNode;
  /** Overrides the default monospace source box (e.g. to syntax-highlight). */
  renderSource?: () => ReactNode;
  actions?: { copy?: boolean; save?: boolean; codeToggle?: boolean };
  /** Expand straight into the live render (HTML) rather than the source (React). */
  defaultRenderedView?: boolean;
  onExpand?: () => void;
}

/**
 * The one card every artifact type renders into: corner badge, header row, action
 * buttons, expand state, and a body that is either a live render or the source.
 * Types supply what differs and opt into the actions that make sense for them --
 * a chart has no meaningful "copy source", a Python script has no cheap live render.
 */
const ArtifactPreviewCard: React.FC<ArtifactPreviewCardProps> = ({
  artifactId,
  artifactType,
  mimeType,
  artifactContent,
  title,
  icon,
  chipLabel,
  chipColor = 'primary',
  stats,
  extra,
  testIdPrefix,
  source,
  copyTooltip = 'Copy to clipboard',
  copyMessage = 'Copied to clipboard',
  saveTooltip = 'Save as file',
  saveFile,
  renderPreview,
  renderSource,
  actions = {},
  defaultRenderedView = true,
  onExpand,
}) => {
  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const queryClient = useQueryClient();
  const { isFeatureEnabled } = useFeatureEnabled();
  const artifactsEnabled = isFeatureEnabled('enableArtifacts');

  const hasPreview = !!renderPreview;
  const hasSource = !!source || !!renderSource;
  // A code toggle only means something when there are two views to flip between.
  const showCodeToggle = !!actions.codeToggle && hasPreview && hasSource;

  const [isExpanded, setIsExpanded] = useState(!artifactsEnabled);
  const [showRenderedPreview, setShowRenderedPreview] = useState(defaultRenderedView);

  const isSelected = useSessionLayout(s => s.selectedArtifactId) === artifactId;

  // With no source to fall back to, the live render is the only body there is.
  const renderedView = hasPreview && (hasSource ? showRenderedPreview : true);

  // Clicking the card body always opens into the live render -- that is the payoff of
  // clicking an artifact. `defaultRenderedView` only decides what the chevron reveals,
  // which is why React starts on source but still previews on a card click. Once
  // expanded, a click flips between render and source (only meaningful when both exist).
  const handleToggleInlinePreview = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!isExpanded) {
      setIsExpanded(true);
      if (hasPreview) setShowRenderedPreview(true);
      return;
    }
    if (showCodeToggle) setShowRenderedPreview(!showRenderedPreview);
  };

  const handleOpenInViewer = (e?: React.MouseEvent) => {
    e?.stopPropagation();

    // Force a fresh fetch so the viewer opens on the persisted artifact, not a stale cache.
    queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] });
    queryClient.invalidateQueries({ queryKey: ['artifactVersions', artifactId] });

    setSessionLayout({
      layout: 'vertical',
      artifactData: { type: artifactType, content: artifactContent, mimeType, id: artifactId },
      selectedArtifactId: artifactId,
    } as Parameters<typeof setSessionLayout>[0]);
    // Open at the artifact's own latest version: clear any per-artifact selection so a
    // version chosen earlier for this artifact doesn't override the fresh open.
    setSelectedArtifactVersion(artifactId, undefined);
    onExpand?.();
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!source) return;
    navigator.clipboard.writeText(source);
    toast.success(copyMessage);
  };

  const handleSaveAsFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!source || !saveFile) return;
    try {
      const { fileName, mimeType: fileMimeType, successMessage } = saveFile();
      const file = new File([source], fileName, { type: fileMimeType });
      const fileData = {
        type: KnowledgeType.FILE,
        fileName,
        mimeType: fileMimeType,
        fileSize: file.size,
      };
      const fabFile = await createFabFileOnServerWithUpload(fileData, file);
      const newWorkBenchFiles = [...workBenchFiles, fabFile];
      setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);
      if (currentSession) {
        const knowledgeIds = newWorkBenchFiles.map(f => f.id);
        setCurrentSession({ ...currentSession, knowledgeIds });
      }
      toast.success(successMessage);
    } catch (error) {
      console.error('Error saving file:', error);
      toast.error('Failed to save file');
    }
  };

  // Keep the open side panel in step with this card's content while a reply streams in.
  useEffect(() => {
    const currentState = useSessionLayout.getState();
    if (currentState.selectedArtifactId !== artifactId || currentState.artifactData?.type !== artifactType) return;
    if (JSON.stringify(currentState.artifactData.content) === JSON.stringify(artifactContent)) return;

    setSessionLayout({
      artifactData: { ...currentState.artifactData, content: artifactContent },
    } as Parameters<typeof setSessionLayout>[0]);
  }, [artifactId, artifactType, artifactContent]);

  return (
    <Card
      variant="outlined"
      data-testid={`${testIdPrefix}-artifact-card`}
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
        {icon}
      </Box>

      {/* No padding here: the Card already provides it. */}
      <Box>
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
              data-testid={`${testIdPrefix}-artifact-toggle-btn`}
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
            {title}
          </Typography>

          <Chip size="sm" variant="soft" color={chipColor}>
            {chipLabel}
          </Chip>

          {actions.copy && source && (
            <Tooltip title={copyTooltip} placement="top">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={handleCopy}
                data-testid={`${testIdPrefix}-artifact-copy-btn`}
              >
                <CopyIcon />
              </IconButton>
            </Tooltip>
          )}

          {actions.save && source && saveFile && (
            <Tooltip title={saveTooltip} placement="top">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={handleSaveAsFile}
                data-testid={`${testIdPrefix}-artifact-save-btn`}
              >
                <SaveIcon />
              </IconButton>
            </Tooltip>
          )}

          {showCodeToggle && (
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
                data-testid={`${testIdPrefix}-artifact-preview-btn`}
              >
                {showRenderedPreview ? <CodeViewIcon /> : <PreviewIcon />}
              </IconButton>
            </Tooltip>
          )}

          <Tooltip title="Open in full viewer" placement="top">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={handleOpenInViewer}
              data-testid={`${testIdPrefix}-artifact-expand-btn`}
            >
              <ExpandIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        {stats && (
          <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
            {stats}
          </Stack>
        )}

        {extra}

        {isExpanded && renderedView ? (
          <Box sx={{ mt: 1 }} onClick={e => e.stopPropagation()}>
            {renderPreview?.()}
          </Box>
        ) : hasSource ? (
          renderSource ? (
            <Box sx={{ mt: 1 }}>{renderSource()}</Box>
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
              data-testid={`${testIdPrefix}-artifact-source`}
            >
              <Typography level="body-xs" sx={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
                {isExpanded
                  ? source
                  : `${source!.split('\n').slice(0, 3).join('\n').substring(0, 120)}${
                      source!.length > 120 ? '...' : ''
                    }`}
              </Typography>
            </Box>
          )
        ) : null}
      </Box>
    </Card>
  );
};

export default ArtifactPreviewCard;
