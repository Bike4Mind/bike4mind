import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import {
  formatMemberCredits,
  getMemberCreditBudgetNotice,
} from '@client/app/components/organizations/memberCreditBudget';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DataUsageRoundedIcon from '@mui/icons-material/DataUsageRounded';
import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { useState } from 'react';

/**
 * Non-blocking composer note warning an org member before the server's per-member monthly credit
 * cap blocks them (see `getMemberCreditBudgetNotice`). Reads the selected billing org's cached
 * document, so it can trail actual spend by up to that query's stale time; the server's refusal
 * message stays authoritative.
 */
export function MemberCreditBudgetNote() {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const { currentUser } = useUser();
  const { selectedAccount } = useSelectedAccount();
  const organizationId = selectedAccount && !selectedAccount.personal ? selectedAccount.id : null;
  const { data: organization } = useGetOrganization(organizationId);
  const [dismissed, setDismissed] = useState(false);

  const notice = organization && currentUser ? getMemberCreditBudgetNotice(organization, currentUser.id) : null;
  if (!notice || dismissed) return null;

  const accent = isDarkMode ? '#fbbf24' : '#a16207';
  const border = isDarkMode ? 'rgba(234, 179, 8, 0.4)' : 'rgba(202, 138, 4, 0.35)';
  const bg = isDarkMode ? 'rgba(120, 80, 20, 0.35)' : 'rgba(254, 249, 195, 0.8)';
  const used = formatMemberCredits(notice.used);
  const cap = formatMemberCredits(notice.cap);

  return (
    <Box
      data-testid="session-member-credit-budget-note"
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: '8px',
        px: 1.5,
        py: 0.75,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <DataUsageRoundedIcon sx={{ fontSize: '18px', color: accent, flexShrink: 0 }} />
        <Typography data-testid="member-credit-budget-note-text" sx={{ fontSize: '12px', color: 'text.secondary' }}>
          {notice.exhausted
            ? `You've used your monthly limit of ${cap} credits in ${organization!.name}. It resets on ${notice.resetsOn}.`
            : `You've used ${used} of your ${cap} monthly credits in ${organization!.name}. It resets on ${notice.resetsOn}.`}
        </Typography>
      </Box>
      <IconButton
        data-testid="member-credit-budget-note-dismiss"
        size="sm"
        variant="plain"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss credit limit note"
        sx={{ color: accent, flexShrink: 0, minHeight: '22px', minWidth: '22px' }}
      >
        <CloseRoundedIcon sx={{ fontSize: '16px' }} />
      </IconButton>
    </Box>
  );
}
