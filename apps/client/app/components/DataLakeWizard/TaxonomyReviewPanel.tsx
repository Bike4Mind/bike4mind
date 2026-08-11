import {
  Alert,
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Stack,
  Typography,
} from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { memo, useEffect, useState } from 'react';
import type { IDataLakeBatchSummary, TaxonomyTag } from '@bike4mind/common';
import {
  useApplyTaxonomySuggestions,
  useDismissTaxonomy,
  useReanalyzeTaxonomy,
} from '@client/app/hooks/data/dataLakes';
import { useConfirmation } from '@client/app/hooks/useConfirmation';

// Confidence tier helpers

type ConfidenceTier = 'high' | 'medium' | 'low';

function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 0.9) return 'high';
  if (score >= 0.75) return 'medium';
  return 'low';
}

function getTierColor(tier: ConfidenceTier): 'success' | 'warning' | 'danger' {
  switch (tier) {
    case 'high':
      return 'success';
    case 'medium':
      return 'warning';
    case 'low':
      return 'danger';
  }
}

function getTierLabel(tier: ConfidenceTier): string {
  switch (tier) {
    case 'high':
      return 'High Confidence (90-100%)';
    case 'medium':
      return 'Medium Confidence (75-89%)';
    case 'low':
      return 'Low Confidence (< 75%)';
  }
}

// Individual Tag Card

interface TagCardProps {
  tag: TaxonomyTag;
  /** The lake's already-fixed tag prefix; fixed in the card, never edited here (prefix
   * ownership moved entirely to the Config step, before upload). */
  prefix: string;
  onUpdate: (originalName: string, updates: Partial<TaxonomyTag>) => void;
  onDelete: (originalName: string) => void;
}

const TagCard = memo(function TagCard({ tag, prefix, onUpdate, onDelete }: TagCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editSuffix, setEditSuffix] = useState(tag.suffix);

  // Only the suffix is editable; the prefix is fixed, so a rename can never inject a second
  // namespace. An empty suffix is invalid - block save (and exit) until it has a value.
  const trimmedSuffix = editSuffix.trim();
  const canSave = trimmedSuffix.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    if (trimmedSuffix !== tag.suffix) {
      onUpdate(tag.originalName, { suffix: trimmedSuffix });
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditSuffix(tag.suffix);
    setIsEditing(false);
  };

  if (tag.deleted) return null;

  const tier = getConfidenceTier(tag.strength);

  return (
    <Box
      data-testid="taxonomy-tag-card"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 0.75,
        px: 1.5,
        borderRadius: 'sm',
        '&:hover': { bgcolor: 'background.level1' },
      }}
    >
      {/* Confidence indicator */}
      <Chip size="sm" variant="soft" color={getTierColor(tier)} sx={{ minWidth: 42, justifyContent: 'center' }}>
        {Math.round(tag.strength * 100)}%
      </Chip>

      {/* Tag suffix (editable); the prefix is fixed and shared across all cards */}
      {isEditing ? (
        <Stack direction="row" gap={0.5} sx={{ flex: 1 }}>
          <Input
            size="sm"
            data-testid="taxonomy-tag-suffix-input"
            value={editSuffix}
            error={!canSave}
            onChange={e => setEditSuffix(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') handleCancel();
            }}
            startDecorator={
              <Box component="span" sx={{ fontFamily: 'monospace', color: 'text.tertiary' }}>
                {prefix}
              </Box>
            }
            autoFocus
            sx={{ flex: 1, fontFamily: 'monospace' }}
          />
          <IconButton
            size="sm"
            variant="soft"
            color="success"
            disabled={!canSave}
            data-testid="taxonomy-tag-save"
            onClick={handleSave}
          >
            <CheckIcon sx={{ fontSize: 14 }} />
          </IconButton>
          <IconButton size="sm" variant="soft" color="neutral" onClick={handleCancel}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Stack>
      ) : (
        <Typography
          level="body-sm"
          fontFamily="monospace"
          sx={{ flex: 1, cursor: 'pointer' }}
          onClick={() => setIsEditing(true)}
        >
          <Box component="span" sx={{ color: 'text.tertiary' }}>
            {prefix}
          </Box>
          {tag.suffix}
        </Typography>
      )}

      {/* Source badge */}
      <Chip size="sm" variant="outlined" color={tag.source === 'ai' ? 'primary' : 'neutral'}>
        {tag.source === 'ai' ? 'AI' : 'folder'}
      </Chip>

      {/* Folders this tag will be applied to */}
      {tag.matchingFolders.length > 0 && (
        <Typography level="body-xs" color="neutral" sx={{ maxWidth: 200 }} noWrap>
          {tag.matchingFolders.join(', ')}
        </Typography>
      )}

      {/* Actions */}
      {!isEditing && (
        <Stack direction="row" gap={0}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            data-testid="taxonomy-tag-edit"
            onClick={() => setIsEditing(true)}
          >
            <EditIcon sx={{ fontSize: 14 }} />
          </IconButton>
          <IconButton
            size="sm"
            variant="plain"
            color="danger"
            data-testid="taxonomy-tag-delete"
            onClick={() => onDelete(tag.originalName)}
          >
            <DeleteOutlineIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Stack>
      )}
    </Box>
  );
});

/**
 * Review/apply panel for a batch's background AI tag suggestions. Replaces the old
 * pre-upload TaxonomyReviewStep: analysis now runs AFTER upload, so this is a standalone
 * modal opened from the Data Lakes manager (`DataLakeManagerPanel`) rather than a wizard step -
 * edits live in local state here, not the wizard store, and "Apply" writes tags directly to
 * the batch's already-uploaded files via the apply-taxonomy endpoint.
 */
export default function TaxonomyReviewPanel({
  batch,
  prefix,
  onClose,
}: {
  batch: IDataLakeBatchSummary;
  /** The lake's fixed tag prefix (fetched separately - the batch doc doesn't carry it). */
  prefix: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [tags, setTags] = useState<TaxonomyTag[]>(batch.taxonomySuggestions?.tags ?? []);
  const applyMutation = useApplyTaxonomySuggestions(batch.id);
  const reanalyzeMutation = useReanalyzeTaxonomy(batch.id);
  const dismissMutation = useDismissTaxonomy(batch.id);
  const confirm = useConfirmation();

  // Re-seed local edits whenever the batch's stored suggestions change identity (e.g. after
  // a re-analyze completes and the list refetches with a fresh taxonomySuggestions object).
  useEffect(() => {
    setTags(batch.taxonomySuggestions?.tags ?? []);
  }, [batch.taxonomySuggestions]);

  const updateTag = (originalName: string, updates: Partial<TaxonomyTag>) =>
    setTags(prev => prev.map(t => (t.originalName === originalName ? { ...t, ...updates } : t)));
  const deleteTag = (originalName: string) =>
    setTags(prev => prev.map(t => (t.originalName === originalName ? { ...t, deleted: true } : t)));

  const activeTags = tags.filter(t => !t.deleted);
  const allTiers: { tier: ConfidenceTier; tags: TaxonomyTag[] }[] = [
    { tier: 'high', tags: activeTags.filter(t => getConfidenceTier(t.strength) === 'high') },
    { tier: 'medium', tags: activeTags.filter(t => getConfidenceTier(t.strength) === 'medium') },
    { tier: 'low', tags: activeTags.filter(t => getConfidenceTier(t.strength) === 'low') },
  ];
  const tiers = allTiers.filter(group => group.tags.length > 0);

  const isFailed = batch.taxonomyStatus === 'failed';

  return (
    <Modal open onClose={onClose}>
      <ModalDialog
        data-testid="taxonomy-review-panel"
        sx={{ width: { xs: '95%', sm: '90%', md: '70%' }, maxWidth: '48rem', maxHeight: '85vh', overflow: 'hidden' }}
      >
        <DialogTitle>Review AI Tag Suggestions</DialogTitle>
        <DialogContent sx={{ overflow: 'auto' }}>
          {isFailed ? (
            <Alert color="warning" startDecorator={<ErrorOutlineIcon />}>
              <Box>
                <Typography level="title-sm">AI tagging failed</Typography>
                <Typography level="body-sm">
                  {batch.taxonomyError || 'Something went wrong suggesting tags for this batch.'} Files still have their
                  folder-based tags.
                </Typography>
              </Box>
            </Alert>
          ) : (
            <Stack gap={2}>
              <Typography level="body-sm" color="neutral">
                {activeTags.length} tag categor{activeTags.length === 1 ? 'y' : 'ies'} will be applied to matching
                files, in addition to their existing folder tags.
                {tags.filter(t => t.deleted).length > 0 && ` (${tags.filter(t => t.deleted).length} removed)`}
              </Typography>

              {tiers.map(({ tier, tags: tierTags }) => (
                <Box key={tier}>
                  <Typography
                    level="body-xs"
                    fontWeight="bold"
                    sx={{
                      mb: 0.5,
                      px: 1,
                      py: 0.25,
                      bgcolor: theme.palette.mode === 'dark' ? 'neutral.800' : 'neutral.100',
                      borderRadius: 'sm',
                    }}
                  >
                    {getTierLabel(tier)} ({tierTags.length})
                  </Typography>
                  <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'md', overflow: 'hidden' }}>
                    {tierTags.map(tag => (
                      <TagCard
                        key={tag.originalName}
                        tag={tag}
                        prefix={prefix}
                        onUpdate={updateTag}
                        onDelete={deleteTag}
                      />
                    ))}
                  </Box>
                </Box>
              ))}

              {activeTags.length === 0 && (
                <Box data-testid="taxonomy-empty-state" sx={{ textAlign: 'center', py: 4 }}>
                  <Typography color="neutral">
                    No tag categories suggested. Files keep their folder-based tags - try re-analyzing.
                  </Typography>
                </Box>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          {activeTags.length > 0 && !isFailed && (
            <Button
              variant="solid"
              color="success"
              data-testid="taxonomy-apply-btn"
              loading={applyMutation.isPending}
              onClick={() => applyMutation.mutate(tags, { onSuccess: onClose })}
            >
              Apply Tags
            </Button>
          )}
          <Button
            variant="outlined"
            color="neutral"
            data-testid="taxonomy-reanalyze-btn"
            startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
            loading={reanalyzeMutation.isPending}
            onClick={() => reanalyzeMutation.mutate(undefined)}
          >
            Re-analyze
          </Button>
          <Button
            variant="outlined"
            color="neutral"
            data-testid="taxonomy-dismiss-btn"
            loading={dismissMutation.isPending}
            onClick={() =>
              confirm({
                type: 'danger',
                title: 'Dismiss Suggestion',
                description: 'This clears the suggestion from your list. Files keep whatever tags they already have.',
                okLabel: 'Dismiss',
                onOk: async () => {
                  dismissMutation.mutate(undefined, { onSuccess: onClose });
                },
              })
            }
          >
            Dismiss
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
