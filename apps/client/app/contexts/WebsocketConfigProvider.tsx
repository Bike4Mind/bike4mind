import { ReactNode } from 'react';
import { useConfig } from '@client/app/hooks/data/settings';
import { WebsocketProvider } from './WebsocketContext';

interface Props {
  children: ReactNode;
}

/**
 * Wrapper component that fetches WebSocket URL at runtime from serverConfig.
 *
 * This is necessary because NEXT_PUBLIC_* env vars are inlined at build time,
 * but in CI the Next.js build happens before SST deploys the WebSocket API.
 * The serverConfig endpoint returns the correct URL at runtime.
 */
export const WebsocketConfigProvider = ({ children }: Props) => {
  const { data: config } = useConfig();

  // Pass URL to WebsocketProvider - it handles undefined gracefully
  // WebSocket only connects when both URL and accessToken are valid
  const websocketUrl = config?.websocketUrl;

  return <WebsocketProvider url={websocketUrl}>{children}</WebsocketProvider>;
};
