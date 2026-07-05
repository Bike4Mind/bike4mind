import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Listens for `invalidate_query` websocket messages and invalidates the matching query key,
 * keeping the client cache in sync when server data changes in real-time.
 */
const WebsocketReactQueryInvalidateListener = () => {
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = subscribeToAction('invalidate_query', async msg => {
      if (msg.action !== 'invalidate_query') return;
      queryClient.invalidateQueries({ queryKey: msg.queryKey });
    });

    return () => {
      unsubscribe();
    };
  }, [queryClient, subscribeToAction]);

  return null;
};
export default WebsocketReactQueryInvalidateListener;
