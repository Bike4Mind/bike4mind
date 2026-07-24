import { Box, Button, Chip, CircularProgress, IconButton, Input, Stack, Typography } from '@mui/joy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { useTheme } from '@mui/joy/styles';
import { memo, useCallback, useState } from 'react';
import { useDataLakeWizardStore, type TaxonomyTag } from '@client/app/stores/useDataLakeWizardStore';
import { useInferTaxonomy } from '@client/app/hooks/data/dataLakeWizard';

// Confidence tier helpers

function getConfidenceTier(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.9) return 'high';
  if (score >= 0.75) return 'medium';
  return 'low';
}

function getTierColor(tier: 'high' | 'medium' | 'low'): 'success' | 'warning' | 'danger' {
  switch (tier) {
    case 'high':
      return 'success';
    case 'medium':
      return 'warning';
    case 'low':
      return 'danger';
  }
}

function getTierLabel(tier: 'high' | 'medium' | 'low'): string {
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
  onUpdate: (originalName: string, updates: Partial<TaxonomyTag>) => void;
  onDelete: (originalName: string) => void;
}

const TagCard = memo(function TagCard({ tag, onUpdate, onDelete }: TagCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(tag.name);

  const handleSave = () => {
    if (editName.trim() && editName !== tag.name) {
      onUpdate(tag.originalName, { name: editName.trim() });
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditName(tag.name);
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

      {/* Tag name (editable) */}
      {isEditing ? (
        <Stack direction="row" gap={0.5} sx={{ flex: 1 }}>
          <Input
            size="sm"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') handleCancel();
            }}
            autoFocus
            sx={{ flex: 1 }}
          />
          <IconButton size="sm" variant="soft" color="success" onClick={handleSave}>
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
          {tag.name}
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

// Main Taxonomy Review Step

export default function TaxonomyReviewStep() {
  const theme = useTheme();
  const taxonomy = useDataLakeWizardStore(s => s.taxonomy);
  const setTagPrefix = useDataLakeWizardStore(s => s.setTagPrefix);
  const updateTag = useDataLakeWizardStore(s => s.updateTag);
  const deleteTag = useDataLakeWizardStore(s => s.deleteTag);
  const inferTaxonomy = useInferTaxonomy();

  // Pass the prefix the user may have edited above, so re-analyzing returns tags in their
  // namespace instead of silently reverting to whatever the model picks on its own.
  const handleReanalyze = useCallback(() => {
    inferTaxonomy.mutate({ existingPrefix: taxonomy.prefix || undefined });
  }, [inferTaxonomy, taxonomy.prefix]);

  // Auto-trigger inference on first mount if not yet attempted
  const [autoTriggered, setAutoTriggered] = useState(false);
  if (!taxonomy.attempted && !taxonomy.analyzing && !autoTriggered) {
    setAutoTriggered(true);
    // Use setTimeout to avoid setState during render
    setTimeout(() => inferTaxonomy.mutate({}), 0);
  }

  // Loading state
  if (taxonomy.analyzing) {
    return (
      <Box
        data-testid="wizard-taxonomy-step"
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          p: 4,
        }}
      >
        <CircularProgress size="lg" />
        <Typography level="title-md">Analyzing folder structure...</Typography>
        <Typography level="body-sm" color="neutral">
          AI is examining your files and suggesting a tag taxonomy
        </Typography>
      </Box>
    );
  }

  // Group active tags by confidence tier
  const activeTags = taxonomy.tags.filter(t => !t.deleted);
  type ConfidenceTier = 'high' | 'medium' | 'low';
  const allTiers: { tier: ConfidenceTier; tags: TaxonomyTag[] }[] = [
    { tier: 'high' as const, tags: activeTags.filter(t => getConfidenceTier(t.strength) === 'high') },
    { tier: 'medium' as const, tags: activeTags.filter(t => getConfidenceTier(t.strength) === 'medium') },
    { tier: 'low' as const, tags: activeTags.filter(t => getConfidenceTier(t.strength) === 'low') },
  ];
  const tiers = allTiers.filter(group => group.tags.length > 0);

  return (
    <Box
      data-testid="wizard-taxonomy-step"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, p: 2, overflow: 'auto' }}
    >
      {/* Header row: Tag Prefix input + re-analyze button. Tag Prefix's single editable home
          is HERE (#829): the prefix is embedded in every applied tag name and consumed by
          Re-analyze, so this is where it drives behavior. The Config step shows it read-only
          (append mode) rather than as a second editable copy that could drift out of sync. */}
      <Stack direction="row" gap={2} alignItems="flex-end" flexWrap="wrap">
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
            Tag Prefix
          </Typography>
          <Input
            size="sm"
            data-testid="taxonomy-tag-prefix-input"
            value={taxonomy.prefix}
            onChange={e => setTagPrefix(e.target.value)}
            placeholder="e.g. acme:"
            startDecorator={<AutoAwesomeIcon sx={{ fontSize: 16 }} />}
            sx={{ fontFamily: 'monospace' }}
          />
        </Box>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography level="body-xs" fontWeight="bold" sx={{ mb: 0.5 }}>
            Suggested Name
          </Typography>
          <Typography level="body-sm">{taxonomy.suggestedName || '-'}</Typography>
        </Box>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<RefreshIcon sx={{ fontSize: 16 }} />}
          onClick={handleReanalyze}
          loading={inferTaxonomy.isPending}
        >
          Re-analyze
        </Button>
      </Stack>

      {/* Summary */}
      <Typography level="body-sm" color="neutral">
        {activeTags.length} tag categor{activeTags.length === 1 ? 'y' : 'ies'} will be applied to matching files
        {taxonomy.tags.filter(t => t.deleted).length > 0 && ` (${taxonomy.tags.filter(t => t.deleted).length} removed)`}
        . This step is optional - you can skip it and keep folder-based tags only.
      </Typography>

      {/* Tags grouped by confidence tier */}
      {tiers.map(({ tier, tags }) => (
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
            {getTierLabel(tier)} ({tags.length})
          </Typography>
          <Box
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 'md',
              overflow: 'hidden',
            }}
          >
            {tags.map(tag => (
              <TagCard key={tag.originalName} tag={tag} onUpdate={updateTag} onDelete={deleteTag} />
            ))}
          </Box>
        </Box>
      ))}

      {/* Empty state */}
      {activeTags.length === 0 && taxonomy.attempted && (
        <Box data-testid="taxonomy-empty-state" sx={{ textAlign: 'center', py: 4 }}>
          <Typography color="neutral">
            No tag categories suggested. Files will still be tagged by their source folder - continue, or re-analyze
            with different files or added context.
          </Typography>
          <Button size="sm" variant="soft" sx={{ mt: 1 }} onClick={handleReanalyze}>
            Re-analyze
          </Button>
        </Box>
      )}
    </Box>
  );
}
