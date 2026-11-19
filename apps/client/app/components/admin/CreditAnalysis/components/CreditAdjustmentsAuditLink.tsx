import React from 'react';
import { Button } from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from '@tanstack/react-router';
import { adminAuditLogPath } from '@bike4mind/common';
import { AdminPageHeader } from '../../shared';

/**
 * Admin credit changes are recorded in the Admin Audit Log (user.credits.adjusted and the other
 * category=credits actions), which supersedes the old cross-user adjustments table.
 */
export const CreditAdjustmentsAuditLink: React.FC = () => {
  const navigate = useNavigate();

  const openAuditLog = () => {
    // adminAuditLogPath is the shared deep-link builder (also used by Slack and alert links), so the
    // filter names here stay in sync with what the Audit Log reads from the URL.
    const search = Object.fromEntries(new URL(adminAuditLogPath({ category: 'credits' }), 'http://local').searchParams);
    void navigate({ to: '/admin', search: search as never });
  };

  return (
    <div data-testid="credit-adjustments-audit-link">
      <AdminPageHeader
        title="Credit adjustments"
        level="section"
        description="Admin credit changes are recorded in the Audit Log. Each entry has the admin, the user, the amount, the reason, the balance before and after, and a link to its ledger row. Filter by admin, user or date and export to CSV there."
        actions={
          <Button
            variant="soft"
            endDecorator={<OpenInNewIcon />}
            onClick={openAuditLog}
            data-testid="credit-adjustments-audit-log-link"
          >
            Open credit changes in the Audit Log
          </Button>
        }
      />
    </div>
  );
};
