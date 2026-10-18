import { useUser } from '@client/app/contexts/UserContext';
import { useGetInbox } from '@client/app/hooks/data/inbox';
import { useGetUserInvites } from '@client/app/hooks/data/invites';
import { Badge } from '@mui/joy';
import { FC, ReactNode, useMemo } from 'react';

/**
 * Whether the inbox has an unread message or a pending invite. Reads the same cached inbox and invites
 * queries as the inbox itself, so calling it from several places adds no requests.
 */
export function useInboxHasUnread(): boolean {
  const { currentUser } = useUser();
  const userEmail = currentUser?.email;

  const { data: inbox } = useGetInbox(currentUser?.id || '');
  // Kept fresh by InboxProvider's debounced invalidate of ['invites', 'inbox'] (contexts/InboxContext.tsx);
  // its callers (the sidenav header's Inbox bell) sit inside that provider, so this holds no invites
  // subscription of its own.
  const { data: invites } = useGetUserInvites(currentUser?.id || '');

  return useMemo(() => {
    const unreadInbox = inbox?.some(item => {
      // Only count messages that would actually be displayed in the message list
      // Skip messages without sender data (except SYSTEM messages)
      if (item.userId !== 'SYSTEM' && !item.sender) {
        return false;
      }
      return !item.readAt;
    });
    const pendingInvites = invites?.filter(invite => invite?.recipients?.pending?.includes(userEmail || ''));
    return !!unreadInbox || (!!pendingInvites && pendingInvites.length > 0);
  }, [inbox, invites, userEmail]);
}

const InboxBadge: FC<{ children: ReactNode }> = ({ children }) => {
  const hasUnread = useInboxHasUnread();

  return (
    <Badge
      size={'sm'}
      color={'danger'}
      invisible={!hasUnread}
      data-testid="inbox-badge"
      data-unread={hasUnread ? 'true' : 'false'}
    >
      {children}
    </Badge>
  );
};

export default InboxBadge;
