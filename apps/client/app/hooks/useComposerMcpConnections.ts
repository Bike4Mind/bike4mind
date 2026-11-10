import type { IMcpConnectionPublic } from '@bike4mind/common';
import { composerConnections } from '@client/app/components/integrations/customMcp/customMcpModel';
import { useMcpConnections } from '@client/app/hooks/data/mcpConnections';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';

const NONE: IMcpConnectionPublic[] = [];

/**
 * The viewer's custom MCP connectors as the composer sees them: `offered` are the ones a Tools menu
 * row can switch, `all` is every connection (for pruning stale slugs), and `loaded` says `all` is
 * the server's answer rather than a placeholder. Empty, with no request, while
 * EnableCustomMcpConnectors is off.
 */
export function useComposerMcpConnections(): {
  all: IMcpConnectionPublic[];
  offered: IMcpConnectionPublic[];
  loaded: boolean;
} {
  const { isFeatureEnabled } = useAdminSettingsCache();
  const enabled = isFeatureEnabled('EnableCustomMcpConnectors');
  const { data, isSuccess } = useMcpConnections({ enabled });
  const all = enabled && data ? data : NONE;
  return { all, offered: composerConnections(all), loaded: enabled && isSuccess };
}
