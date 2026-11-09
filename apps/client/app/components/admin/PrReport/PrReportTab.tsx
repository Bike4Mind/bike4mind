import { useState } from 'react';
import { Box, Button, Stack, Tooltip } from '@mui/joy';

import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { SettingsDraftProvider } from '../SettingsDraftProvider';
import { AdminPageHeader } from '../shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP } from '../shared/adminStyles';
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
    <Stack sx={{ gap: ADMIN_REGION_GAP, maxWidth: ADMIN_DETAIL_MAX_WIDTH }} data-testid="admin-pr-report-tab">
      <AdminPageHeader
        title="PR digest"
        description="Drafts a Slack digest of open pull requests that tags whoever owes the next move. Nothing posts until you review and send it."
        actions={
          <Tooltip title={repoConfigured ? '' : 'Save a repository below first.'} disableHoverListener={repoConfigured}>
            <Box component="span">
              <Button onClick={() => setOpen(true)} disabled={!repoConfigured} data-testid="admin-pr-report-open-btn">
                Generate digest
              </Button>
            </Box>
          </Tooltip>
        }
      />

      {/* Each field stages its edit for the provider's one SaveBar and leave-page guard. */}
      <SettingsDraftProvider>
        <PrReportSettings />
      </SettingsDraftProvider>

      {/* Mounted only while open so each run starts from a fresh draft and a fresh
          idempotency key, rather than reusing the previous attempt's send state. */}
      {open && <PrReportDialog open={open} onClose={() => setOpen(false)} />}
    </Stack>
  );
}

// Default export so AdminPage can lazy-load it with `dynamic()`, matching the other tabs.
export default PrReportTab;
