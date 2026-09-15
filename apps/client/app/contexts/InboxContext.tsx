import { IInboxDocument, IInviteDocument } from '@bike4mind/common';
import React, { createContext, ReactNode, useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import InboxModal from '../components/inbox/Modal';
import { useUser } from './UserContext';
import { useQueryClient } from '@tanstack/react-query';
import { updateAllQueryData, useSubscribeCollection } from '../utils/react-query';

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

  const inviteCallback = useCallback(
    (type: string, data: IInviteDocument) => {
      const operation = type === 'delete' ? type : 'write';
      updateAllQueryData(queryClient, 'invites', operation, data, {
        keysAllowedToCreate: [['invites', 'inbox']],
      });
    },
    [queryClient]
  );

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
