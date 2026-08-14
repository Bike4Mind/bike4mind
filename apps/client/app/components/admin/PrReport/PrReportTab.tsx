import { useState } from 'react';
import { Box, Button, List, ListItem, Sheet, Typography } from '@mui/joy';

import { PrReportDialog } from './PrReportDialog';

/**
 * PR report generator - admin entry point.
 *
 * Thin by design: the capability's real surface is the generate → edit → preview → send
 * dialog, and the human checkpoint in the middle is the whole point. This tab exists to
 * open it and to name the settings it depends on, since the egress guard fails closed
 * and an unconfigured deployment would otherwise reject every post with no obvious cause.
 */
export function PrReportTab() {
  const [open, setOpen] = useState(false);

  return (
    <Box>
      <Typography level="h4" sx={{ mb: 0.5 }}>
        PR Status Digest
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2 }}>
        Buckets the configured repository&apos;s open pull requests by workflow state and renders a Slack digest that
        tags whoever owes the next move. Generating is read-only - you review and edit the draft, then send it
        explicitly. Nothing posts on its own.
      </Typography>

      <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'sm', mb: 2 }}>
        <Typography level="title-sm">Required admin settings</Typography>
        <List size="sm" marker="disc">
          <ListItem>
            <Typography level="body-xs">
              <strong>prReportRepo</strong> - the <code>owner/repo</code> to report on
            </Typography>
          </ListItem>
          <ListItem>
            <Typography level="body-xs">
              <strong>prReportIdentityMap</strong> - GitHub logins and role keys (<code>reviewer_</code>,{' '}
              <code>devops_</code>) mapped to Slack member IDs
            </Typography>
          </ListItem>
          <ListItem>
            <Typography level="body-xs">
              <strong>prReportSlackChannel</strong> - the channel to post to
            </Typography>
          </ListItem>
          <ListItem>
            <Typography level="body-xs">
              <strong>prReportEgressAllowlist</strong> - hosts the digest may post to. Empty rejects every send by
              design
            </Typography>
          </ListItem>
        </List>
      </Sheet>

      <Button onClick={() => setOpen(true)} data-testid="admin-pr-report-open-btn">
        Generate digest
      </Button>

      {/* Mounted only while open so each run starts from a fresh draft and a fresh
          idempotency key, rather than reusing the previous attempt's send state. */}
      {open && <PrReportDialog open={open} onClose={() => setOpen(false)} />}
    </Box>
  );
}

// Default export so AdminPage can lazy-load it with `dynamic()`, matching the other tabs.
export default PrReportTab;
