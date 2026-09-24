import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Card, Typography, Chip, Stack, IconButton, Tooltip } from '@mui/joy';
import ShowMoreButton from '@client/app/components/common/ShowMoreButton';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import {
  OpenInFullOutlined as ExpandIcon,
  ContentCopyOutlined as CopyIcon,
  SaveOutlined as SaveIcon,
} from '@mui/icons-material';
import { setSessionLayout, setSelectedArtifactVersion, type ArtifactData } from '@client/app/hooks/useSessionLayout';
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
import { actionButtonSx } from '@client/app/components/common/actionButtonSx';
import HighlightedCode from '@client/app/components/common/HighlightedCode';

// Re-exported so existing importers keep working; it lives in common/ to keep this module
// out of the markdown renderer's import graph (see the note on the recipe itself).
export { actionButtonSx };

/** How much of a non-rendering artifact's source a card shows before offering the rest. */
const SOURCE_COLLAPSED_MAX_HEIGHT = 360;

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
  /** Prism language for the inline source body. Omit for plain text. */
  sourceLanguage?: string;
  /** Overrides the default monospace source box (e.g. to syntax-highlight). */
  renderSource?: () => ReactNode;
  actions?: { copy?: boolean; save?: boolean };
  /** Expand straight into the live render (HTML) rather than the source (React). */
  defaultRenderedView?: boolean;
  /**
   * Whether the card prints its source when it has no render to show. Off for a type whose
   * source is not for reading - a lattice model is machine-serialised JSON, and the card's
   * stats line says far more about it than its first 360px of text.
   */
  inlineSource?: boolean;
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
  sourceLanguage,
  copyTooltip = 'Copy to clipboard',
  copyMessage = 'Copied to clipboard',
  saveTooltip = 'Save as file',
  saveFile,
  renderPreview,
  renderSource,
  actions = {},
  defaultRenderedView = true,
  inlineSource = true,
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

  // Which body the card shows is fixed per type now: switching between the render and the
  // source is the viewer's job, where there is room to read either (ArtifactModeTabs). In a
  // transcript the card shows the type's own default and nothing else.
  // With no source to fall back to, the live render is the only body there is.
  const renderedView = hasPreview && (hasSource ? defaultRenderedView : true);

  // A card that expands into a live render shows no body at all once collapsed. Its source
  // teaser is the first three lines of the file, which for HTML is DOCTYPE boilerplate that
  // reads identically on every artifact; source-primary types (React, code, Python) keep it.
  const showSourceBody = hasSource && !renderedView && inlineSource;

  // The source body is bounded by measured height, not by line count. A lattice model is
  // serialised without indentation, so it is ONE line that wraps into hundreds of pixels -
  // counting lines sees nothing to truncate. Measuring catches both that and an ordinary
  // long script. Honours the reader's auto-collapse switch, like the code card.
  const { settings } = useUserSettings();
  const [showFullSource, setShowFullSource] = useState(false);
  const [sourceOverflows, setSourceOverflows] = useState(false);
  // How many lines the fold is hiding, so the control can say so - the code card names its
  // count and this one used to say a bare "Show more". Derived from the measurement rather
  // than counted, because the bound is a height: with wrapping, a line is not a row. That
  // makes it an estimate, which is all a label needs.
  const [hiddenLineCount, setHiddenLineCount] = useState(0);
  const sourceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sourceRef.current;
    if (!el || !settings.autoCollapseContent) {
      setSourceOverflows(false);
      setHiddenLineCount(0);
      return;
    }
    const overflows = el.scrollHeight > SOURCE_COLLAPSED_MAX_HEIGHT + 4;
    setSourceOverflows(overflows);

    if (!overflows || !source) {
      setHiddenLineCount(0);
      return;
    }
    const totalLines = source.split('\n').length;
    const perLine = el.scrollHeight / totalLines;
    const visibleLines = Math.max(1, Math.floor(SOURCE_COLLAPSED_MAX_HEIGHT / perLine));
    setHiddenLineCount(Math.max(0, totalLines - visibleLines));
  }, [source, settings.autoCollapseContent]);
  const sourceIsBounded = sourceOverflows && !showFullSource;

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
        // reading.cardBase, not a chrome surface: a card's fill is its own decision, and
        // light needs a neutral one so the veil below is the only colour on it.
        backgroundColor: theme.palette.reading.cardBase,
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
        borderColor: theme.palette.reading.cardLine,
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
          // Inset from the card's left edge, overhanging only the top. It used to overhang
          // on the left too, which needed a breakpoint dance: below `sm` the message stack
          // drops its inline padding (Session/MessageContent), so the card sits flush with
          // the screen edge and a left overhang was clipped. An inset pill has no such
          // problem at any width.
          left: '16px',
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
              level="title-md"
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
              // The card's own onClick opens the viewer, so swallow clicks meant for the button.
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
                overflow: 'hidden',
                borderRadius: '6px',
                maxHeight: sourceIsBounded ? `${SOURCE_COLLAPSED_MAX_HEIGHT}px` : undefined,
              }}
              ref={sourceRef}
              data-testid={`${testIdPrefix}-artifact-source`}
            >
              {/* The same code surface a fenced block and a code card use. This body used
                  to be an 11px unhighlighted Typography on background.level2, a token this
                  theme never defines - so the one artifact family that shows its source
                  was the one place code did not look like code. */}
              <HighlightedCode code={source ?? ''} language={sourceLanguage} />
            </Box>
          )
        ) : null}

        {showSourceBody && !renderSource && sourceOverflows && (
          <ShowMoreButton
            expanded={showFullSource}
            onToggle={() => setShowFullSource(v => !v)}
            // A one-line source that wraps (a serialised model) hides no LINES, so the
            // count would read "0 more lines"; that case keeps the bare label.
            collapsedLabel={hiddenLineCount > 0 ? `Show ${hiddenLineCount} more lines` : undefined}
            testId={`${testIdPrefix}-artifact-show-more-btn`}
          />
        )}

        {/* Stop propagation so clicks inside the modal don't reach the Card's onClick and
            open the viewer behind the open dialog. */}
        <Box onClick={e => e.stopPropagation()}>{artifactShareModal}</Box>
      </Box>
    </Card>
  );
};

export default ArtifactPreviewCard;
