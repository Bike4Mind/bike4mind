import { useEffect, useMemo } from 'react';

import { CALLABLE_FUNCTION_TOOL_CONNECTION_ID, IMcpServerResponse } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useComposerMcpConnections } from '@client/app/hooks/useComposerMcpConnections';

/**
 * Keeps enabledMcpServers in LLM state synchronized with the database.
 * - Initializes enabledMcpServers when it is null and servers are available.
 * - Cleans up stale server entries when a server is removed from the database
 *   (e.g. GitHub OAuth revoked).
 * - Drops custom connector slugs from disabledMcpConnections once the user's own connector is gone,
 *   so a new connector that reuses the slug starts on. Only against a loaded list, never the empty
 *   placeholder. The internal function choice survives independently of connector records. A platform connector is switched by id in enabledPlatformMcpConnections, which is
 *   never pruned: an admin switching it off and on keeps the user's choice, and a recreated one has a
 *   new id and starts off.
 */
export function useMcpServerSync(): void {
  const enabledMcpServers = useLLM(s => s.enabledMcpServers);
  const { setState: setLLM } = useLLM;
  const { data: mcpServersData = [] } = useMcpServers();

  const availableMcpServers = useMemo(
    () => mcpServersData.filter((server: IMcpServerResponse) => server.enabled !== false),
    [mcpServersData]
  );

  useEffect(() => {
    if (enabledMcpServers === null && availableMcpServers.length > 0) {
      setLLM({ enabledMcpServers: availableMcpServers.map(server => server.name) });
      return;
    }

    if (Array.isArray(enabledMcpServers) && enabledMcpServers.length > 0 && mcpServersData !== undefined) {
      const availableServerNames = availableMcpServers.map(s => s.name.toLowerCase());
      const stillValid = enabledMcpServers.filter(name => availableServerNames.includes(name.toLowerCase()));

      if (stillValid.length !== enabledMcpServers.length) {
        setLLM({ enabledMcpServers: stillValid.length > 0 ? stillValid : null });
      }
    }
  }, [enabledMcpServers, availableMcpServers, mcpServersData, setLLM]);

  const disabledMcpConnections = useLLM(s => s.disabledMcpConnections);
  const { all: connections, loaded: connectionsLoaded } = useComposerMcpConnections();

  useEffect(() => {
    if (!connectionsLoaded || !Array.isArray(disabledMcpConnections) || disabledMcpConnections.length === 0) return;
    const slugs = new Set(
      connections.filter(connection => connection.ownerType !== 'platform').map(connection => connection.slug)
    );
    const stillValid = disabledMcpConnections.filter(
      slug => slug === CALLABLE_FUNCTION_TOOL_CONNECTION_ID || slugs.has(slug)
    );
    if (stillValid.length !== disabledMcpConnections.length) setLLM({ disabledMcpConnections: stillValid });
  }, [connections, connectionsLoaded, disabledMcpConnections, setLLM]);
}
