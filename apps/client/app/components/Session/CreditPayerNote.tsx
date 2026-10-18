import type { IProjectDocument, ISessionDocument } from '@bike4mind/common';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useGetJoinedProjects } from '@client/app/hooks/data/projects';

interface PayerNoteArgs {
  currentUserId: string | undefined;
  session: Pick<ISessionDocument, 'id' | 'userId'> | null | undefined;
  projects: Pick<IProjectDocument, 'userId' | 'sessionIds'>[] | undefined;
  /** The account the next send bills; a non-personal one is an organization pool. */
  account: { name: string; personal: boolean } | null | undefined;
}

/**
 * The composer's payer line, or null when the user is in their own notebook. The server bills the
 * organization the send carries, else the SENDER (ChatCompletionProcess credit
 * reservation) - never the notebook's or project's owner, which a member could easily assume.
 * Restated statically in SHARED_USAGE_BILLING_NOTE (inbox/Invites.tsx) and
 * PROJECT_MEMBERS_BILLING_NOTE (Project/Members.tsx) - keep in sync.
 */
export function payerNoteText({ currentUserId, session, projects, account }: PayerNoteArgs): string | null {
  if (!currentUserId || !session) return null;
  const inOthersNotebook = !!session.userId && session.userId !== currentUserId;
  const inOthersProject = (projects ?? []).some(
    p => p.userId !== currentUserId && (p.sessionIds ?? []).includes(session.id)
  );
  if (!inOthersNotebook && !inOthersProject) return null;
  if (account && !account.personal) return `Paid from ${account.name} credits, not the owner's`;
  return "Paid from your balance, not the owner's";
}

const JOINED_PROJECTS_STALE_MS = 5 * 60 * 1000;

/**
 * Who pays for answers in a notebook the user does not own, as one line, or null when it is their
 * own (or credits are not enforced). The balance chip on the composer's status line shows it as an
 * info mark and puts the line first in its tooltip (CreditBalanceChip).
 */
export function useCreditPayerNote(session: ISessionDocument | null | undefined): string | null {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const currentUserId = useUser(s => s.currentUser?.id);
  const organizationId = useLLM(s => s.organizationId);
  const { selectedAccount } = useSelectedAccount();
  const { data: projects } = useGetJoinedProjects(currentUserId ?? '', {
    enabled: enforceCredits && !!session,
    staleTime: JOINED_PROJECTS_STALE_MS,
  });

  if (!enforceCredits) return null;
  // Read the payer from the organizationId the send carries (useSendMessage), not the account menu:
  // the menu's persisted pick is only copied into it while a useAccounts consumer is mounted, so
  // after a reload with the sidebar closed the two disagree and the server bills the user.
  const account = organizationId
    ? { name: selectedAccount?.id === organizationId ? selectedAccount.name : 'your organization', personal: false }
    : null;
  return payerNoteText({ currentUserId, session, projects, account });
}
