import { IInboxDocument, IInviteDocument } from '@bike4mind/common';
import React, { createContext, ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import InboxModal from '../components/inbox/Modal';
import { useUser } from './UserContext';
import { useQueryClient } from '@tanstack/react-query';
import { updateAllQueryData, useSubscribeCollection } from '../utils/react-query';
import { useCoalescedInvalidate } from '../hooks/useCoalescedInvalidate';

export type InviteEventListener = (type: string, data: IInviteDocument) => void;

// InboxProvider owns the single `invites` subscription and fans its events out here, so a consumer
// that also needs invite events listens instead of opening a second subscribe (each subscribe
// replays one event per document in scope, so N subscribes cost N server-side bursts).
const inviteListeners = new Set<InviteEventListener>();

/**
 * Runs `listener` for every invites event InboxProvider receives. The listener is kept in a ref, so
 * an inline callback does not re-register on each render.
 */
export const useInviteEvents = (listener: InviteEventListener) => {
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  }, [listener]);

  useEffect(() => {
    const forward: InviteEventListener = (type, data) => listenerRef.current(type, data);
    inviteListeners.add(forward);
    return () => {
      inviteListeners.delete(forward);
    };
  }, []);
};

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

  const invalidateInvites = useCoalescedInvalidate(['invites', 'inbox']);

  // Refetch rather than write the event's document: the subscription withholds `recipients` from
  // non-admins (server/websocket/dataSubscribeFieldLimits.ts), and the inbox filters on it.
  const inviteCallback = useCallback(
    (type: string, data: IInviteDocument) => {
      invalidateInvites();
      for (const listener of inviteListeners) {
        try {
          listener(type, data);
        } catch (error) {
          // Isolate a consumer so it cannot drop the event for the others.
          console.error('invite event listener failed', error);
        }
      }
    },
    [invalidateInvites]
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
