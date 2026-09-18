import React, { type ReactNode } from 'react';
import { Box, Button, Card, Typography, Chip, Stack, IconButton, Tooltip } from '@mui/joy';
import type { Theme } from '@mui/joy';
import {
  OpenInFullOutlined as ExpandIcon,
  ContentCopyOutlined as CopyIcon,
  SaveOutlined as SaveIcon,
} from '@mui/icons-material';
import useSessionLayout, {
  setSessionLayout,
  setSelectedArtifactVersion,
  type ArtifactData,
} from '@client/app/hooks/useSessionLayout';
import { useSelectedArtifactContentSync } from '@client/app/hooks/useSelectedArtifactContentSync';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { brand } from '@client/app/utils/themes/colors';
import { useUser } from '@client/app/contexts/UserContext';
import { usePublishShare } from '@client/app/hooks/usePublishShare';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { buildArtifactPublishWiring } from '@client/app/utils/publishApi';
import type { ArtifactType } from '@bike4mind/common';

// Shared by copy / save / open-in-viewer: 18px glyphs dimmed to 70%, brightening to full
// on hover, over the same hover fill the sidebar items use (notebooklist.hoverBg) rather
// than Joy's default plain-variant hover. Joy icons take their color from --Icon-color.
export const actionButtonSx = (theme: Theme) => ({
  // Joy sizes an IconButton from --IconButton-size; `width`/`height` alone lose to its
  // own minWidth/minHeight, so all three are needed to get off the 32px `sm` default.
  '--IconButton-size': '24px',
  minWidth: '24px',
  minHeight: '24px',
  '--Icon-fontSize': '16px',
  '--Icon-color': theme.vars.palette.text.primary70,
  '&:hover': {
    backgroundColor: theme.palette.notebooklist.hoverBg,
    '--Icon-color': theme.vars.palette.text.primary,
  },
});

export interface ArtifactSaveFile {
  fileName: string;
  mimeType: string;
  successMessage: string;
}

export interface ArtifactPreviewCardProps {
  artifactId: string;
  /** Discriminant on sessionLayout.artifactData; selects the side-panel viewer. */
  artifactType: ArtifactData['type'];
  mimeType: string;
  /** Payload handed to the side-panel viewer. */
  artifactContent: ArtifactData['content'];
  /**
   * The string that changes on a live content edit (usually the artifact's raw content).
   * Drives useSelectedArtifactContentSync's change detection -- see that hook for why it
   * keys on this rather than the whole content object.
   */
  contentKey: string;
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
  actions?: { copy?: boolean; save?: boolean };
  /** Expand straight into the live render (HTML) rather than the source (React). */
  defaultRenderedView?: boolean;
  /**
   * Types whose body IS the artifact (SVG) set this false: the graphic is always shown,
   * the chevron is dropped, and clicking the card does not collapse it.
   */
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
  contentKey,
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
  onExpand,
}) => {
  const { currentSession, setCurrentSession, currentSessionId } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const queryClient = useQueryClient();

  const shareUser = useUser(s => s.currentUser);
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const activeOrg = selectedAccount && !selectedAccount.personal ? selectedAccount : null;
  const teamOrg = activeOrg && String(activeOrg.id) === String(shareUser?.organizationId) ? activeOrg : null;
  const { publishAndShare: publishAndShareArtifact, modal: artifactShareModal } = usePublishShare();

  const hasPreview = !!renderPreview;
  const hasSource = !!source || !!renderSource;

  // Cards mount expanded: the body is the thing the reader asked for. This used to seed from
  // the `enableArtifacts` flag, which gates artifact GENERATION and has never gated their
  // display -- so it only ever hid the artifact behind a click for the users who had the
  // feature switched on, which is the admin default.

  const isSelected = useSessionLayout(s => s.selectedArtifactId) === artifactId;

  // Which body the card shows is fixed per type now: switching between the render and the
  // source is the viewer's job, where there is room to read either (ArtifactModeTabs). In a
  // transcript the card shows the type's own default and nothing else.
  // With no source to fall back to, the live render is the only body there is.
  const renderedView = hasPreview && (hasSource ? defaultRenderedView : true);

  // A card that expands into a live render shows no body at all once collapsed. Its source
  // teaser is the first three lines of the file, which for HTML is DOCTYPE boilerplate that
  // reads identically on every artifact; source-primary types (React, code, Python) keep it.
  const showSourceBody = hasSource && !renderedView;

  const handleOpenInViewer = (e?: React.MouseEvent) => {
    e?.stopPropagation();

    // Force a fresh fetch so the viewer opens on the persisted artifact, not a stale cache.
    queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] });
    queryClient.invalidateQueries({ queryKey: ['artifactVersions', artifactId] });

    setSessionLayout({
      layout: 'vertical',
      artifactData: { type: artifactType, content: artifactContent, mimeType, id: artifactId } as ArtifactData,
      selectedArtifactId: artifactId,
    });
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

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!source?.trim()) return;
    if (!shareUser?.id) {
      toast.error('You must be signed in to publish');
      return;
    }
    // questmaster publishes as 'code'; all other types use their own discriminant.
    const publishType: ArtifactType = artifactType === 'questmaster' ? 'code' : (artifactType as ArtifactType);
    publishAndShareArtifact({
      title,
      ...(teamOrg ? { orgOption: { label: 'Team', hint: `Members of ${teamOrg.name}` } } : {}),
      ...buildArtifactPublishWiring({
        artifactId,
        type: publishType,
        content: source,
        title,
        userId: String(shareUser.id),
        orgId: teamOrg?.id,
      }),
    });
  };

  // Push live content changes to the Knowledge Base store. Guarded: a card that merely
  // mounts (scrolled back into view) must not overwrite the store with older content (#457).
  useSelectedArtifactContentSync(artifactId, artifactType, contentKey, artifactContent);

  return (
    <Card
      variant="outlined"
      data-testid={`${testIdPrefix}-artifact-card`}
      sx={theme => ({
        // surface2 is the sidebar/header surface. Joy's background.level1 default is not
        // defined by this theme, so the cards would otherwise sit on an unpicked color.
        backgroundColor: 'background.surface2',
        // Same card recipe as a fenced code block (markdown/syntaxTheme.ts): the
        // fill stays the theme's own surface and a brand-blue veil falls across
        // it, so every framed thing a reply produces is one family. backgroundImage
        // rather than a background shorthand, so the fill above still resolves per
        // color scheme.
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
        },
      })}
      onClick={handleOpenInViewer}
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
          // Below `sm` the message stack drops its inline padding (Session/MessageContent),
          // so the card sits flush with the screen edge and a left overhang would be
          // clipped. Same breakpoint as that padding; there the pill sits inset from the
          // card edge instead, keeping only the top overhang.
          left: '16px',
          [theme.breakpoints.up('sm')]: { left: '-8px' },
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
        {/* Title and stats are one block, so the trailing controls centre against the pair
            rather than against the title alone. Matches CodeArtifactPreviewCard - keep the
            two in sync. */}
        <Stack direction="row" spacing={1} alignItems="center">
          <Stack sx={{ minWidth: 0 }}>
            <Typography
              level="title-sm"
              sx={{
                color: 'text.primary',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </Typography>
            {stats && (
              <Stack direction="row" spacing={2}>
                {stats}
              </Stack>
            )}
          </Stack>

          <Box sx={{ flex: 1 }} />

          {/* One block so the plain icons space and shrink together. Matches
              CodeArtifactPreviewCard - keep the two in sync. */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            {actions.copy && source && (
              <Tooltip title={copyTooltip} placement="top">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  sx={actionButtonSx}
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
                  sx={actionButtonSx}
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
                sx={actionButtonSx}
                onClick={handleOpenInViewer}
                data-testid={`${testIdPrefix}-artifact-expand-btn`}
              >
                <ExpandIcon />
              </IconButton>
            </Tooltip>

            {source && (
              // The card's own onClick collapses it, so swallow clicks meant for the button.
              <Box onClick={e => e.stopPropagation()} sx={{ display: 'flex', flexShrink: 0 }}>
                <Button
                  size="sm"
                  variant="solid"
                  onClick={handleShare}
                  data-testid={`${testIdPrefix}-artifact-share-btn`}
                  sx={{
                    backgroundColor: brand[800],
                    color: '#fff',
                    fontWeight: 600,
                    // Pin to the same rendered height as the IconButtons beside it (24px).
                    '--Button-minHeight': '24px',
                    '--Button-paddingBlock': '0.25rem',
                    '--Button-paddingInline': '12px',
                    lineHeight: 1,
                    // Colour alone on hover. It sits in a row of still, quiet icons, where a
                    // button that grows and glows is the only thing moving on the card.
                    transition: 'background-color 0.15s ease',
                    '&:hover': {
                      backgroundColor: brand[900],
                    },
                  }}
                >
                  Share
                </Button>
              </Box>
            )}
          </Box>
        </Stack>

        {extra}

        {renderedView ? (
          // The render stays live: an artifact is an interactive thing, and a counter you
          // cannot click is a screenshot of one. The viewer opens from the card's chrome and
          // the viewer button instead. (An HTML preview is an iframe, so clicks inside it
          // never reach this card at all - that area drives the artifact, nothing else.)
          <Box sx={{ mt: 2 }}>{renderPreview?.()}</Box>
        ) : showSourceBody ? (
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
              }}
              data-testid={`${testIdPrefix}-artifact-source`}
            >
              <Typography level="body-xs" sx={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
                {source}
              </Typography>
            </Box>
          )
        ) : null}

        {/* Stop propagation so clicks inside the modal don't reach the Card's onClick and
            open the viewer behind the open dialog. */}
        <Box onClick={e => e.stopPropagation()}>{artifactShareModal}</Box>
      </Box>
    </Card>
  );
};

export default ArtifactPreviewCard;
