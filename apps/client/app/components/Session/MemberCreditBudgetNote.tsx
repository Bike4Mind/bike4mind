import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import {
  formatMemberCredits,
  getMemberCreditBudgetNotice,
} from '@client/app/components/organizations/memberCreditBudget';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { Box, IconButton, Typography, useTheme } from '@mui/joy';
import { useState } from 'react';
import type { SxProps } from '@mui/joy/styles/types';
import { HEADER_ICON_BUTTON_SX } from '@client/app/components/Session/AISettings/headerIconButtonSx';

/**
 * The note itself, with no data of its own so a preview can render it. Sits above the composer
 * (SessionBottom), not inside the box: it is about the account, not the message being written.
 */
export function MemberCreditBudgetNoteView({
  text,
  onDismiss,
  sx,
}: {
  text: string;
  onDismiss: () => void;
  sx?: SxProps;
}) {
  const theme = useTheme();
  const isDarkMode = theme.palette.mode === 'dark';
  const border = isDarkMode ? 'rgba(234, 179, 8, 0.4)' : 'rgba(202, 138, 4, 0.35)';
  const bg = isDarkMode ? 'rgba(120, 80, 20, 0.35)' : 'rgba(254, 249, 195, 0.8)';

  return (
    <Box
      data-testid="session-member-credit-budget-note"
      sx={[
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: '8px',
          p: '8px',
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      <Typography data-testid="member-credit-budget-note-text" sx={{ fontSize: '13px', color: 'text.primary' }}>
        {text}
      </Typography>
      <IconButton
        data-testid="member-credit-budget-note-dismiss"
        size="sm"
        variant="plain"
        onClick={onDismiss}
        aria-label="Dismiss credit limit note"
        sx={{ ...HEADER_ICON_BUTTON_SX, flexShrink: 0 }}
      >
        <CloseRoundedIcon sx={{ fontSize: '16px' }} />
      </IconButton>
    </Box>
  );
}

/**
 * Non-blocking note warning an org member before the server's per-member monthly credit
 * cap blocks them (see `getMemberCreditBudgetNotice`). Reads the selected billing org's cached
 * document, so it can trail actual spend by up to that query's stale time; the server's refusal
 * message stays authoritative.
 */
export function MemberCreditBudgetNote({ sx }: { sx?: SxProps }) {
  const { currentUser } = useUser();
  const { selectedAccount } = useSelectedAccount();
  const organizationId = selectedAccount && !selectedAccount.personal ? selectedAccount.id : null;
  const { data: organization } = useGetOrganization(organizationId);
  const [dismissed, setDismissed] = useState(false);

  const notice = organization && currentUser ? getMemberCreditBudgetNotice(organization, currentUser.id) : null;
  if (!notice || dismissed) return null;

  const used = formatMemberCredits(notice.used);
  const cap = formatMemberCredits(notice.cap);
  const text = notice.exhausted
    ? `You've used your monthly limit of ${cap} credits in ${organization!.name}. It resets on ${notice.resetsOn}.`
    : `You've used ${used} of your ${cap} monthly credits in ${organization!.name}. Requests that would go over it are blocked until it resets on ${notice.resetsOn}.`;

  return <MemberCreditBudgetNoteView text={text} onDismiss={() => setDismissed(true)} sx={sx} />;
}
