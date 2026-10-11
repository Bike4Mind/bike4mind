import type { IProjectDocument, ISessionDocument } from '@bike4mind/common';
import { Typography } from '@mui/joy';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useGetJoinedProjects } from '@client/app/hooks/data/projects';

interface PayerNoteArgs {
  currentUserId: string | undefined;
  session: Pick<ISessionDocument, 'id' | 'userId'> | null | undefined;
  projects: Pick<IProjectDocument, 'userId' | 'sessionIds'>[] | undefined;
  /** The billing account picked in the account menu; a non-personal one is an organization pool. */
  account: { name: string; personal: boolean } | null | undefined;
}

/**
 * The composer's payer line, or null when the user is in their own notebook. The server bills the
 * organization picked in the account menu, else the SENDER (ChatCompletionProcess credit
 * reservation) - never the notebook's or project's owner, which a member could easily assume.
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

/** One quiet line above the composer naming who pays for answers in a notebook the user does not own. */
export function CreditPayerNote({ session }: { session: ISessionDocument | null | undefined }) {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const currentUserId = useUser(s => s.currentUser?.id);
  const { selectedAccount } = useSelectedAccount();
  const { data: projects } = useGetJoinedProjects(currentUserId ?? '', {
    enabled: enforceCredits && !!session,
    staleTime: JOINED_PROJECTS_STALE_MS,
  });

  if (!enforceCredits) return null;
  const text = payerNoteText({ currentUserId, session, projects, account: selectedAccount });
  if (!text) return null;

  return (
    <Typography
      data-testid="session-credit-payer-note"
      level="body-xs"
      sx={{ color: 'text.tertiary', mb: 0.5, px: 0.5 }}
    >
      {text}
    </Typography>
  );
}
