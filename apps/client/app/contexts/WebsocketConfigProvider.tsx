import { ReactNode } from 'react';
import { useClientConfig } from '@client/app/hooks/data/clientConfig';
import { WebsocketProvider } from './WebsocketContext';

interface Props {
  children: ReactNode;
}

/**
 * Wrapper component that fetches the WebSocket URL from the shared bootstrap query.
 *
 * This is necessary because NEXT_PUBLIC_* env vars are inlined at build time,
 * but in CI the Next.js build happens before SST deploys the WebSocket API.
 * The client-config endpoint returns the correct URL at runtime.
 */
export const WebsocketConfigProvider = ({ children }: Props) => {
  const { data: config } = useClientConfig();

  // Pass URL to WebsocketProvider - it handles undefined gracefully
  // WebSocket only connects when both URL and accessToken are valid
  const websocketUrl = config?.transport?.websocket_url;

  return <WebsocketProvider url={websocketUrl}>{children}</WebsocketProvider>;
};
