import { useCallback, useEffect, useState } from 'react';
import type { TerminalInfo } from '@shared/terminal';

export interface TerminalsState {
  terminals: TerminalInfo[];
  /** False until main has answered for this conversation. */
  loaded: boolean;
  error: string | null;
  create(): Promise<TerminalInfo | null>;
  restart(terminalId: string): Promise<void>;
  close(terminalId: string): Promise<void>;
}

/**
 * One conversation's terminals, while `enabled` - the panel being open. Closed, nothing is read
 * and nothing is subscribed, so the panel costs a conversation nothing until it is asked for.
 */
export function useTerminals(sessionId: string | null, enabled: boolean): TerminalsState {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTerminals([]);
    setLoaded(false);
    setError(null);
    if (!sessionId || !enabled) return;
    let live = true;
    const off = window.b4m.terminal.onChanged(event => {
      if (event.sessionId === sessionId) setTerminals(event.terminals);
    });
    void window.b4m.terminal.list(sessionId).then(list => {
      if (!live) return;
      setTerminals(list);
      setLoaded(true);
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, enabled]);

  const create = useCallback(async () => {
    if (!sessionId) return null;
    setError(null);
    // The view fits the real size the moment it mounts; this is only what the shell starts at.
    const result = await window.b4m.terminal.create({ sessionId, cols: 80, rows: 24 });
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setTerminals(current =>
      current.some(entry => entry.id === result.terminal.id) ? current : [...current, result.terminal]
    );
    return result.terminal;
  }, [sessionId]);

  const restart = useCallback(async (terminalId: string) => {
    const next = await window.b4m.terminal.restart(terminalId);
    if (next) setTerminals(current => current.map(entry => (entry.id === terminalId ? next : entry)));
  }, []);

  const close = useCallback(async (terminalId: string) => {
    setTerminals(current => current.filter(entry => entry.id !== terminalId));
    await window.b4m.terminal.close(terminalId);
  }, []);

  return { terminals, loaded, error, create, restart, close };
}
