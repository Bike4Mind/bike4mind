import { useUser } from '@client/app/contexts/UserContext';
import { useGetInbox } from '@client/app/hooks/data/inbox';
import { useGetUserInvites } from '@client/app/hooks/data/invites';
import { Badge } from '@mui/joy';
import { FC, ReactNode, useMemo, useCallback } from 'react';
import { SubscriptionCallbackFunction } from '@client/app/hooks/useCollection';
import { useQueryClient } from '@tanstack/react-query';
import { IInviteDocument } from '@bike4mind/common';
import { useSubscribeCollection } from '@client/app/utils/react-query';
import debounce from 'lodash/debounce';

const InboxBadge: FC<{ children: ReactNode }> = ({ children }) => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const userEmail = currentUser?.email;

  const { data: inbox } = useGetInbox(currentUser?.id || '');
  const { data: invites } = useGetUserInvites(currentUser?.id || '');

  const debounceFetch = useMemo(
    () =>
      debounce(
        () => {
          queryClient.invalidateQueries({ queryKey: ['invites', 'inbox'] });
        },
        1000 * 60 * 2
      ), // 2 mins to match the cache time of the invites and inbox query
    [queryClient]
  );

  // Subscribe to the invites collection to invalidate the query less frequently
  useSubscribeCollection(
    'invites',
    useMemo(() => ({}), []),
    useCallback<SubscriptionCallbackFunction<IInviteDocument>>(
      (type, data) => {
        if (!userEmail) return;

        // Only handle invites that involve the current user
        const isRelevantToUser = data.recipients?.pending?.includes(userEmail);

        // Only invalidate for relevant changes
        if ((type === 'insert' || type === 'update') && isRelevantToUser) {
          debounceFetch();
        }
      },
      [userEmail, debounceFetch]
    )
  );

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
    <Badge size={'sm'} color={'danger'} invisible={!hasUnread}>
      {children}
    </Badge>
  );
};

export default InboxBadge;
