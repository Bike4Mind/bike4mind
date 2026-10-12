import { IInboxDocument, IInviteDocument } from '@bike4mind/common';
import React, { createContext, ReactNode, useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import debounce from 'lodash/debounce';
import InboxModal from '../components/inbox/Modal';
import { useUser } from './UserContext';
import { useQueryClient } from '@tanstack/react-query';
import { updateAllQueryData, useSubscribeCollection } from '../utils/react-query';

const INVITE_REFETCH_DEBOUNCE_MS = 250;
const INVITE_REFETCH_MAX_WAIT_MS = 1000;

interface InboxContextProps {
  inboxIndex: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  inboxFetching: boolean;
  invitesFetching: boolean;
  setInboxIndex: (index: number) => void;
  sharedSearch: string;
  setSharedSearch: (search: string) => void;
}

export const useInbox = create<InboxContextProps>(set => ({
  inboxIndex: 0,
  inboxFetching: false,
  invitesFetching: false,
  open: false,
  sharedSearch: '',
  setSharedSearch: (search: string) => set({ sharedSearch: search }),
  setOpen: (open: boolean) => set({ open }),
  setInboxIndex: (index: number) => set({ inboxIndex: index }),
}));

export const InboxContext = createContext<InboxContextProps | undefined>(undefined);

export const InboxProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [userId] = useUser(useShallow(s => [s.currentUser?.id]));
  const queryClient = useQueryClient();

  const inboxCallback = useCallback(
    (type: string, data: IInboxDocument) => {
      const operation = type === 'delete' ? type : 'write';
      updateAllQueryData(queryClient, 'inboxes', operation, data, {
        keysAllowedToCreate: [['inboxes']],
      });
    },
    [queryClient]
  );

  // Refetch rather than write the event's document: the subscription withholds `recipients` from
  // non-admins (server/websocket/dataSubscribeFieldLimits.ts), and the inbox filters on it.
  // Debounced because each (re)subscribe replays one event per invite in scope; a burst gets one refetch.
  // maxWait keeps a steady stream of events from deferring the refetch indefinitely.
  const inviteCallback = useMemo(
    () =>
      debounce(() => queryClient.invalidateQueries({ queryKey: ['invites', 'inbox'] }), INVITE_REFETCH_DEBOUNCE_MS, {
        maxWait: INVITE_REFETCH_MAX_WAIT_MS,
      }),
    [queryClient]
  );

  useEffect(() => () => inviteCallback.cancel(), [inviteCallback]);

  useSubscribeCollection<IInboxDocument>(
    'inboxes',
    useMemo(() => (userId ? { receiverId: userId, deletedAt: null as unknown as string } : null), [userId]),
    inboxCallback
  );

  useSubscribeCollection<IInviteDocument>(
    'invites',
    useMemo(() => ({}), []),
    inviteCallback
  );

  return (
    <>
      <InboxModal />
      {children}
    </>
  );
};
