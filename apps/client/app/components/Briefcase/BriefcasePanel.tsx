import { useMemo } from 'react';
import { Box, Typography, CircularProgress, Sheet, Button } from '@mui/joy';
import { BRIEFCASE_CATALOG_QUERIES } from '@bike4mind/common';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useBriefcaseCatalog } from '@client/app/hooks/data/briefcase';
import { BriefcaseLauncher } from './BriefcaseLauncher';

// Keyed by BRIEFCASE_CATALOG_QUERIES keys.
const GROUP_LABELS: Record<string, string> = {
  general: 'General',
  writing: 'Writing',
  learning: 'Learning',
  personal: 'My prompts',
};

/**
 * The briefcase launcher panel - a curated catalog of one-click AI prompts.
 * Feature-gated; renders nothing when EnableBriefcase is off for the user.
 * `onLaunched` lets a host (e.g. the toolbar popover) close itself after a click.
 */
export function BriefcasePanel({ onLaunched }: { onLaunched?: () => void } = {}) {
  const { isFeatureEnabled, isLoading: featureLoading } = useFeatureEnabled();
  const enabled = isFeatureEnabled('enableBriefcase');
  const { data, isLoading, isError, refetch } = useBriefcaseCatalog(BRIEFCASE_CATALOG_QUERIES, enabled);

  // Computed before any early return so the hook order is stable.
  const groups = useMemo(
    () =>
      BRIEFCASE_CATALOG_QUERIES.map(q => ({ key: q.key, prompts: data?.[q.key] ?? [] })).filter(
        g => g.prompts.length > 0
      ),
    [data]
  );

  if (featureLoading || !enabled) return null;

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 1 }} data-testid="briefcase-panel-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (isError) {
    return (
      <Sheet
        variant="soft"
        color="danger"
        sx={{ p: 1, borderRadius: 'sm', display: 'flex', alignItems: 'center', gap: 1 }}
        data-testid="briefcase-panel-error"
      >
        <Typography level="body-sm">Couldn’t load the briefcase.</Typography>
        <Button size="sm" variant="plain" color="danger" onClick={() => void refetch()} data-testid="briefcase-retry">
          Retry
        </Button>
      </Sheet>
    );
  }

  if (groups.length === 0) {
    return (
      <Typography level="body-sm" sx={{ p: 1, opacity: 0.7 }} data-testid="briefcase-panel-empty">
        No prompts yet.
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }} data-testid="briefcase-panel">
      {groups.map(group => (
        <Box key={group.key} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Typography level="body-xs" sx={{ textTransform: 'uppercase', opacity: 0.6 }}>
            {GROUP_LABELS[group.key] ?? group.key}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {group.prompts.map(prompt => (
              <BriefcaseLauncher key={prompt.id} prompt={prompt} onLaunched={onLaunched} />
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
