import { useEffect, useMemo } from 'react';

import { IMcpServerDocument } from '@bike4mind/common';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';

/**
 * Keeps enabledMcpServers in LLM state synchronized with the database.
 * - Initializes enabledMcpServers when it is null and servers are available.
 * - Cleans up stale server entries when a server is removed from the database
 *   (e.g. GitHub OAuth revoked).
 */
export function useMcpServerSync(): void {
  const enabledMcpServers = useLLM(s => s.enabledMcpServers);
  const { setState: setLLM } = useLLM;
  const { data: mcpServersData = [] } = useMcpServers();

  const availableMcpServers = useMemo(
    () => mcpServersData.filter((server: IMcpServerDocument) => server.enabled !== false),
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
}
