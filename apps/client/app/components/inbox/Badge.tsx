import { useUser } from '@client/app/contexts/UserContext';
import { useGetInbox } from '@client/app/hooks/data/inbox';
import { useGetUserInvites } from '@client/app/hooks/data/invites';
import { Badge } from '@mui/joy';
import { FC, ReactNode, useMemo } from 'react';

const InboxBadge: FC<{ children: ReactNode }> = ({ children }) => {
  const { currentUser } = useUser();
  const userEmail = currentUser?.email;

  const { data: inbox } = useGetInbox(currentUser?.id || '');
  // Kept fresh by InboxProvider's debounced invalidate of ['invites', 'inbox'] (contexts/InboxContext.tsx);
  // its mounts (via ProfileMenu) sit inside that provider, so the badge holds no invites subscription of its own.
  const { data: invites } = useGetUserInvites(currentUser?.id || '');

  const hasUnread = useMemo(() => {
    const unreadInbox = inbox?.some(item => {
      // Only count messages that would actually be displayed in the message list
      // Skip messages without sender data (except SYSTEM messages)
      if (item.userId !== 'SYSTEM' && !item.sender) {
        return false;
      }
      return !item.readAt;
    });
    const pendingInvites = invites?.filter(invite => invite?.recipients?.pending?.includes(userEmail || ''));
    return unreadInbox || (pendingInvites && pendingInvites.length > 0);
  }, [inbox, invites, userEmail]);

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
