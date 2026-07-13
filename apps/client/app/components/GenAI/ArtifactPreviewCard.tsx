import React, { useEffect, useState, type ReactNode } from 'react';
import { Box, Card, Typography, Chip, Stack, IconButton, Tooltip } from '@mui/joy';
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
import { brand } from '@client/app/utils/themes/colors';
import SwitchSelector from '@client/app/components/common/fields/SwitchSelector';

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
  chipLabel: ReactNode;
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
  /**
   * Types whose body IS the artifact (SVG) set this false: the graphic is always shown,
   * the chevron is dropped, and clicking the card does not collapse it.
   */
  collapsible?: boolean;
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
  chipLabel,
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
  collapsible = true,
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

  const [collapsedState, setIsExpanded] = useState(!artifactsEnabled);
  const [showRenderedPreview, setShowRenderedPreview] = useState(defaultRenderedView);

  const isExpanded = collapsible ? collapsedState : true;

  const isSelected = useSessionLayout(s => s.selectedArtifactId) === artifactId;

  // With no source to fall back to, the live render is the only body there is.
  const renderedView = hasPreview && (hasSource ? showRenderedPreview : true);

  // Clicking anywhere on the card means exactly one thing: expand/collapse, same as the
  // chevron. Switching between the render and the source is the code/preview button's job
  // alone -- overloading the card click stole the collapse gesture users expect.
  const handleToggleExpand = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!collapsible) return;
    setIsExpanded(!isExpanded);
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
        // surface2 is the sidebar/header surface. Joy's background.level1 default is not
        // defined by this theme, so the cards would otherwise sit on an unpicked color.
        backgroundColor: 'background.surface2',
        borderRadius: '8px',
        position: 'relative',
        overflow: 'visible',
        borderWidth: 1,
        borderColor: isSelected ? 'primary.500' : 'neutral.outlinedBorder',
        transition: 'all 0.2s ease-in-out',
        cursor: collapsible ? 'pointer' : 'default',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: 'sm',
        },
      }}
      onClick={handleToggleExpand}
    >
      {/* Type badge: the icon and the type label are one pill overhanging the card
          corner, so the header row carries only the title and the actions. */}
      <Chip
        size="sm"
        variant="solid"
        data-testid={`${testIdPrefix}-artifact-badge`}
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
        {chipLabel}
      </Chip>

      {/* No padding here: the Card already provides it. */}
      <Box>
        {/* Title leads the row so the stats line below aligns flush with it. Title and
            chevron are their own 4px group; the outer 8px spacing stays for the actions. */}
        <Stack direction="row" spacing={1} alignItems="center">
          <Stack direction="row" alignItems="center" sx={{ minWidth: 0 }}>
            <Typography
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
              {title}
            </Typography>

            {collapsible && (
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
                    '--Icon-fontSize': '16px',
                    '--Icon-color': theme.vars.palette.text.tertiary,
                  })}
                  onClick={handleToggleExpand}
                  data-testid={`${testIdPrefix}-artifact-toggle-btn`}
                >
                  {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </IconButton>
              </Tooltip>
            )}
          </Stack>

          <Box sx={{ flex: 1 }} />

          {/* The toggle leads the action group so it grows leftward: copy/save/viewer keep
              the same right-anchored positions whether or not a type has a toggle. */}
          {showCodeToggle && (
            // The card's own onClick collapses it, so swallow clicks meant for the toggle.
            <Box
              onClick={e => e.stopPropagation()}
              data-testid={`${testIdPrefix}-artifact-preview-btn`}
              sx={{ display: 'flex', flexShrink: 0 }}
            >
              <SwitchSelector
                options={[
                  { value: 'preview', icon: PreviewIcon, tooltip: 'Show preview' },
                  { value: 'code', icon: CodeViewIcon, tooltip: 'Show code' },
                ]}
                value={showRenderedPreview ? 'preview' : 'code'}
                onChange={next => {
                  setIsExpanded(true);
                  setShowRenderedPreview(next === 'preview');
                }}
                size="sm"
              />
            </Box>
          )}

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
          <Box sx={{ mt: 2 }} onClick={e => e.stopPropagation()}>
            {renderPreview?.()}
          </Box>
        ) : hasSource ? (
          renderSource ? (
            <Box sx={{ mt: 2 }}>{renderSource()}</Box>
          ) : (
            <Box
              sx={{
                mt: 2,
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
