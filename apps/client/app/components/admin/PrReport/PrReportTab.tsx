import { useState } from 'react';
import { Box, Button, Card, Divider, Stack, Tooltip, Typography } from '@mui/joy';

import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { PrReportDialog } from './PrReportDialog';
import { PrReportSettings } from './PrReportSettings';

/**
 * PR report generator - admin entry point.
 *
 * The capability's real surface is the generate -> edit -> preview -> send dialog, and the
 * human checkpoint in the middle is the whole point. This tab configures the settings the
 * digest depends on (inline, so no trip to the generic Admin Settings screen) and opens the
 * dialog. The egress guard fails closed, so an unconfigured deployment would otherwise reject
 * every post with no obvious cause - hence surfacing the settings right here.
 */
export function PrReportTab() {
  const [open, setOpen] = useState(false);
  const repo = useGetSettingsValue('prReportRepo');
  const repoConfigured = typeof repo === 'string' && repo.trim().length > 0;

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto', p: { xs: 1, sm: 2 } }}>
      <Stack spacing={0.75} sx={{ mb: 3 }}>
        <Typography level="h3">PR Status Digest</Typography>
        <Typography level="body-sm" textColor="text.secondary">
          Buckets the configured repository&apos;s open pull requests by workflow state and renders a Slack digest that
          tags whoever owes the next move. Generating is read-only - you review and edit the draft, then send it
          explicitly. Nothing posts on its own.
        </Typography>
      </Stack>

      <Card variant="outlined" sx={{ p: 3, gap: 2.5, mb: 3 }}>
        <Box>
          <Typography level="title-md">Configuration</Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            Saved to admin settings and shared across the deployment. Each field saves on its own.
          </Typography>
        </Box>
        <Divider />
        <PrReportSettings />
      </Card>

      <Divider sx={{ mb: 3 }} />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        justifyContent="space-between"
      >
        <Typography level="body-sm" textColor="text.secondary">
          Fetches the current open PRs and drafts a digest. You review and edit it before anything is sent.
        </Typography>
        <Tooltip title={repoConfigured ? '' : 'Set the repository above first.'} disableHoverListener={repoConfigured}>
          <Box sx={{ alignSelf: { xs: 'flex-end', sm: 'auto' } }}>
            <Button onClick={() => setOpen(true)} disabled={!repoConfigured} data-testid="admin-pr-report-open-btn">
              Generate digest
            </Button>
          </Box>
        </Tooltip>
      </Stack>

      {/* Mounted only while open so each run starts from a fresh draft and a fresh
          idempotency key, rather than reusing the previous attempt's send state. */}
      {open && <PrReportDialog open={open} onClose={() => setOpen(false)} />}
    </Box>
  );
}

// Default export so AdminPage can lazy-load it with `dynamic()`, matching the other tabs.
export default PrReportTab;
