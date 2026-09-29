import { useCallback, useEffect, useState } from 'react';
import type { McpServerInput, McpServersState } from '@shared/mcp';

export interface McpServersController extends McpServersState {
  loading: boolean;
  add: (input: McpServerInput) => Promise<string | null>;
  update: (id: string, input: McpServerInput) => Promise<string | null>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
}

/**
 * The MCP server list, kept live.
 *
 * Main pushes the whole state on every change rather than the renderer polling, because the
 * interesting transitions happen without anyone clicking: a server connects seconds after it
 * is added, and one that dies mid-turn has to stop claiming it contributed tools. The add and
 * update calls resolve to an error STRING rather than throwing, since the only failures are
 * the ones the form should show under its own fields.
 */
export function useMcpServers(): McpServersController {
  const [state, setState] = useState<McpServersState>({ servers: [], secretsPersisted: true });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void window.b4m.mcp.getServers().then(next => {
      setState(next);
      setLoading(false);
    });
    return window.b4m.mcp.onChanged(setState);
  }, []);

  const add = useCallback(async (input: McpServerInput) => {
    const result = await window.b4m.mcp.addServer(input);
    if (!result.ok) return result.error;
    setState(result.state);
    return null;
  }, []);

  const update = useCallback(async (id: string, input: McpServerInput) => {
    const result = await window.b4m.mcp.updateServer(id, input);
    if (!result.ok) return result.error;
    setState(result.state);
    return null;
  }, []);

  const remove = useCallback(async (id: string) => setState(await window.b4m.mcp.removeServer(id)), []);

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => setState(await window.b4m.mcp.setServerEnabled(id, enabled)),
    []
  );

  const reconnect = useCallback(async (id: string) => setState(await window.b4m.mcp.reconnectServer(id)), []);

  return { ...state, loading, add, update, remove, setEnabled, reconnect };
}
