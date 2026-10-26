import React from 'react';
import { Autocomplete, Box, Chip, IconButton, Option, Select, Switch, Tooltip, Typography } from '@mui/joy';
import CodeIcon from '@mui/icons-material/Code';
import NotesIcon from '@mui/icons-material/Notes';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import PublishedWithChangesIcon from '@mui/icons-material/PublishedWithChanges';
import RestoreIcon from '@mui/icons-material/Restore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { toast } from 'sonner';
import {
  normalizePublishTag,
  normalizePublishTags,
  PUBLISH_TAGS_MAX,
  PUBLISH_TAG_MAX_LENGTH,
  type PublishVisibility,
} from '@bike4mind/common';
import { canRefreshFromSource, type ManagedArtifact, type PublishAccessGateRead } from '@client/app/utils/publishApi';
import { supportsExport } from '@client/app/utils/publishExport';
import { ManageSharingPanel } from '@client/app/components/common/ManageSharingPanel';
import { PUBLISH_ACCESS_META, isPublishAccess } from '@client/app/components/common/PublishAccessBadge';
import { sourceKindLabel } from './publishedArtifactFormat';

/**
 * Visibility choices for an artifact, valid for its scope tier (a live PATCH cannot move a page to
 * another scope): Public and Private everywhere, plus the tier's own audience for Team/project
 * pages. The current value is always listed, so the select never shows an empty choice.
 */
function visibilityChoicesFor(a: Pick<ManagedArtifact, 'tier' | 'visibility'>): PublishVisibility[] {
  const audience: PublishVisibility[] =
    a.tier === 'organization' ? ['organization'] : a.tier === 'project' ? ['project'] : [];
  const choices: PublishVisibility[] = ['public', ...audience, 'private'];
  return choices.includes(a.visibility) ? choices : [...choices, a.visibility];
}

export interface PublishedArtifactSettingsProps {
  artifact: ManagedArtifact;
  /** Absolute share URL, handed to the sharing panel. */
  url: string;
  /** The owner's tag vocabulary, offered as suggestions (the field itself stays freeform). */
  tagVocabulary: string[];
  /** Any write in flight anywhere in the tab: disables the controls so two writes cannot race. */
  busy: boolean;
  /** `publicId:format` of the export in flight, so only the clicked button shows loading. */
  exporting: string | null;
  /** This artifact's refresh-from-source is in flight. */
  refreshing: boolean;
  sharingOpen: boolean;
  onToggleSharing: () => void;
  /** A gate edit landed in the sharing panel: the tab patches the artifact's access badge. */
  onGateChange: (gate: PublishAccessGateRead) => void;
  /** Called only when the normalized tag list actually changed. */
  onTagsChange: (tags: string[]) => void;
  onVisibilityChange: (visibility: PublishVisibility) => void;
  onCommentsChange: (on: boolean) => void;
  onExport: (format: 'md' | 'html', action: 'copy' | 'download') => void;
  onPrint: () => void;
  /** Called after the owner confirms. */
  onRefresh: () => void;
  onRestore: () => void;
  /** Called after the owner confirms. */
  onDelete: () => void;
}

/**
 * Everything an owner can change on one published artifact: tags, visibility, comments, sharing and
 * embed, export, refresh, restore, delete. One component so the list row (inline, under its expand
 * button) and the grid card (in a dialog, behind its More button) show exactly the same controls
 * with the same test ids. Writes stay with the parent tab - this only renders and calls back.
 */
export function PublishedArtifactSettings({
  artifact: a,
  url,
  tagVocabulary,
  busy,
  exporting,
  refreshing,
  sharingOpen,
  onToggleSharing,
  onGateChange,
  onTagsChange,
  onVisibilityChange,
  onCommentsChange,
  onExport,
  onPrint,
  onRefresh,
  onRestore,
  onDelete,
}: PublishedArtifactSettingsProps) {
  const isBundle = a.source.kind === 'bundle';
  const canRefresh = canRefreshFromSource(a);
  const hasPrevious = Boolean(a.previousVersionMeta?.sha256Index);
  const commentsOn = a.commentPolicy === 'open' || a.commentPolicy === 'restricted';

  return (
    <Box
      data-testid={`published-artifact-settings-${a.publicId}`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <LocalOfferIcon sx={{ fontSize: 15, opacity: 0.6 }} />
        {/* freeSolo because tags are freeform: the vocabulary SUGGESTS, it does not
            restrict. Suggestions merge published-artifact and AppFile tags so one
            label means one thing across the app. */}
        <Autocomplete
          size="sm"
          multiple
          freeSolo
          disableClearable
          placeholder={(a.tags ?? []).length ? '' : 'Add tags'}
          options={tagVocabulary}
          value={a.tags ?? []}
          disabled={busy}
          onChange={(_e, next) => {
            // Normalize with the SAME helper the server uses, so the chips the owner
            // sees are what gets stored - no surprise re-spelling on reload.
            const entered = next as string[];
            const tags = normalizePublishTags(entered);
            // A REJECTED tag (over-long, or past the cap) is dropped rather than
            // rewritten, which made the equality check below see no change: no write, no
            // toast, and the chip just disappeared on the next render. Rewrites are
            // self-explanatory; drops have to be said out loud or the field reads broken.
            //
            // The REASON comes from the entries, not from `tags.length < entered.length`
            // - that is true of any shortening, dedupe and blank-drop included. MUI
            // compares options with ===, so typing `NorthWind` beside an existing `northwind` chip
            // appends the variant and the normalizer then dedupes it: the old check
            // reported a length problem about a four-character tag. Blanks and duplicates
            // stay SILENT, for the same reason a rewrite does - they explain themselves.
            const normalizedEach = entered.map(normalizePublishTag);
            const tooLong = normalizedEach.some(t => t.length > PUBLISH_TAG_MAX_LENGTH);
            const overCap =
              new Set(normalizedEach.filter(t => t && t.length <= PUBLISH_TAG_MAX_LENGTH)).size > PUBLISH_TAGS_MAX;
            // Over-long wins when both hold: it points at a specific bad token, where
            // the cap message can only restate the limit.
            if (tooLong) {
              toast.error(`Tags can be at most ${PUBLISH_TAG_MAX_LENGTH} characters`);
            } else if (overCap) {
              toast.error(`Up to ${PUBLISH_TAGS_MAX} tags per artifact`);
            }
            const current = a.tags ?? [];
            if (tags.length === current.length && tags.every((t, i) => t === current[i])) return;
            onTagsChange(tags);
          }}
          slotProps={{ input: { 'data-testid': `published-artifact-tag-input-${a.publicId}` } }}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'nowrap' }}>
          {(a.tags ?? []).length}/{PUBLISH_TAGS_MAX}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Chip size="sm" variant="soft" color="neutral">
          {sourceKindLabel(a.source.kind)}
        </Chip>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Typography level="body-xs" textColor="text.tertiary">
            Visibility
          </Typography>
          <Select
            size="sm"
            value={a.visibility}
            disabled={busy}
            onChange={(_e, val) => val && val !== a.visibility && onVisibilityChange(val)}
            data-testid={`published-artifact-visibility-${a.publicId}`}
            sx={{ minWidth: 110 }}
          >
            {visibilityChoicesFor(a).map(v => (
              <Option key={v} value={v} data-testid={`published-artifact-visibility-option-${v}`}>
                {isPublishAccess(v) ? PUBLISH_ACCESS_META[v].label : v}
              </Option>
            ))}
          </Select>
        </Box>

        {isBundle && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Typography level="body-xs" textColor="text.tertiary">
              Comments
            </Typography>
            <Switch
              size="sm"
              checked={commentsOn}
              disabled={busy}
              onChange={e => onCommentsChange(e.target.checked)}
              data-testid={`published-artifact-comments-${a.publicId}`}
            />
          </Box>
        )}

        <Box sx={{ flex: 1 }} />

        <Tooltip title="Share, gate & embed">
          <IconButton
            size="sm"
            variant={sharingOpen ? 'soft' : 'plain'}
            color={sharingOpen ? 'primary' : 'neutral'}
            onClick={onToggleSharing}
            data-testid={`published-artifact-manage-${a.publicId}`}
            aria-expanded={sharingOpen}
          >
            <CodeIcon />
          </IconButton>
        </Tooltip>

        {/* Markdown is offered only for kinds it converts to faithfully (replies,
          whose stored body IS markdown) - see exportFormatsFor. Hidden, not
          disabled: a greyed button implies the export exists and is unavailable,
          when in fact there is no honest Markdown form of an HTML bundle. */}
        {supportsExport(a.source.kind, 'md') && (
          <Tooltip title="Copy as Markdown">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              loading={exporting === `${a.publicId}:md`}
              onClick={() => onExport('md', 'copy')}
              data-testid={`published-artifact-copy-md-${a.publicId}`}
            >
              <NotesIcon />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip title="Save as HTML">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            loading={exporting === `${a.publicId}:html`}
            onClick={() => onExport('html', 'download')}
            data-testid={`published-artifact-save-html-${a.publicId}`}
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>

        {/* PDF is produced client-side by printing the HTML export from an
          isolated frame (printToPdf), not a server export format. Offered
          for every kind - the browser renders it visually. */}
        <Tooltip title="Save as PDF (opens print dialog)">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            loading={exporting === `${a.publicId}:pdf`}
            onClick={onPrint}
            data-testid={`published-artifact-save-pdf-${a.publicId}`}
          >
            <PictureAsPdfIcon />
          </IconButton>
        </Tooltip>

        {/* Refresh re-publishes from the source artifact's CURRENT content onto
          the same link. Hidden where there is no source to read back (a reply
          snapshot, or a bundle published from outside the app). */}
        {canRefresh && (
          <Tooltip title="Refresh from source (publishes a new version)">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              disabled={busy}
              loading={refreshing}
              onClick={() => {
                // Outward-facing: it replaces what viewers of a live link see.
                if (
                  window.confirm(
                    `Refresh "${a.title}" from its source artifact? This publishes a new version to the same link.`
                  )
                ) {
                  onRefresh();
                }
              }}
              data-testid={`published-artifact-refresh-${a.publicId}`}
            >
              <PublishedWithChangesIcon />
            </IconButton>
          </Tooltip>
        )}

        {isBundle && (
          <Tooltip title={hasPrevious ? 'Restore the previous version' : 'No previous version to restore'}>
            <span>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                disabled={busy || !hasPrevious}
                onClick={onRestore}
                data-testid={`published-artifact-restore-${a.publicId}`}
              >
                <RestoreIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}

        <Tooltip title="Delete">
          <IconButton
            size="sm"
            variant="plain"
            color="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete "${a.title}"? The share link will stop working.`)) onDelete();
            }}
            data-testid={`published-artifact-delete-${a.publicId}`}
          >
            <DeleteOutlineIcon />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Lazily mounted so the manage-state fetch (gate + embed list) only
          fires for the artifact the owner actually opens. */}
      {sharingOpen && (
        <Box sx={{ mt: 0.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <ManageSharingPanel
            publicId={a.publicId}
            title={a.title}
            shareUrl={url}
            visibility={a.visibility}
            onGateChange={onGateChange}
          />
        </Box>
      )}

      {/* Single-version artifacts have no version switcher yet - explain why
          and how to create history instead of leaving a silent absence. Shown only here, not on the
          collapsed row or the card: it was identical on most artifacts and, repeated down a long
          list, was the single largest consumer of vertical space on the page. */}
      {isBundle && (a.versionsCount ?? 0) < 2 && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          data-testid={`published-artifact-single-version-${a.publicId}`}
        >
          Only one version published -{' '}
          {canRefresh ? 'refresh it from source (or use AI Revise)' : 're-publish this artifact'} to create version
          history. A version switcher appears on the page once there are 2 or more versions.
        </Typography>
      )}
    </Box>
  );
}

export default PublishedArtifactSettings;
