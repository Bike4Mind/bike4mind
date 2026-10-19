import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import {
  formatMemberCredits,
  getMemberCreditBudgetNotice,
} from '@client/app/components/organizations/memberCreditBudget';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { Typography } from '@mui/joy';
import { useState } from 'react';
import type { SxProps } from '@mui/joy/styles/types';
import { ComposerNote } from './ComposerNote';

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
  return (
    <ComposerNote
      data-testid="session-member-credit-budget-note"
      dismissTestId="member-credit-budget-note-dismiss"
      dismissLabel="Dismiss credit limit note"
      onDismiss={onDismiss}
      sx={sx}
    >
      <Typography data-testid="member-credit-budget-note-text" sx={{ fontSize: '13px', color: 'text.primary' }}>
        {text}
      </Typography>
    </ComposerNote>
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
