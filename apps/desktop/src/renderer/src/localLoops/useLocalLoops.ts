import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LocalLoopDetail,
  LocalLoopSummary,
  LocalLoopsResult,
  LocalTicket,
  UpdateLocalTicketRequest,
} from '@shared/localLoops';

/** Absent in builds and tests without the Desktop-loops surface. */
export const localLoopsApi = () => window.b4m?.localLoops;

/** Every Desktop loop, refetched whenever main says any changed. */
export function useLocalLoopList() {
  const [summaries, setSummaries] = useState<LocalLoopSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const api = localLoopsApi();
    if (!api) return;
    const result = await api.list();
    if (result.ok) {
      setSummaries(result.value);
      setError(null);
    } else setError(result.error);
  }, []);
  useEffect(() => {
    const api = localLoopsApi();
    if (!api) return;
    void reload();
    return api.onChanged(() => void reload());
  }, [reload]);
  return { summaries, error, reload };
}

/**
 * One loop's tickets, runs and events. `moveTicket` shows the patch at once and then stores it; a refusal puts that
 * ticket back as it was and sets `error` to the reason. `act` runs any other call and surfaces its refusal the same way.
 */
export function useLocalLoop(loopId: string | null) {
  const [detail, setDetail] = useState<LocalLoopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(loopId);
  current.current = loopId;
  const latest = useRef(detail);
  latest.current = detail;

  const reload = useCallback(async () => {
    const api = localLoopsApi();
    const id = current.current;
    if (!api || !id) return;
    const result = await api.get(id);
    if (current.current !== id) return;
    if (result.ok) setDetail(result.value);
    else setError(result.error);
  }, []);

  useEffect(() => {
    setDetail(null);
    setError(null);
    const api = localLoopsApi();
    if (!api || !loopId) return;
    void reload();
    return api.onChanged(({ loopIds }) => {
      if (loopIds.length === 0 || loopIds.includes(loopId)) void reload();
    });
  }, [loopId, reload]);

  const replaceTicket = (ticket: LocalTicket) =>
    setDetail(
      prev => prev && { ...prev, tickets: prev.tickets.map(entry => (entry.id === ticket.id ? ticket : entry)) }
    );

  const moveTicket = useCallback(async (id: string, patch: Omit<UpdateLocalTicketRequest, 'id'>) => {
    const api = localLoopsApi();
    const before = latest.current?.tickets.find(ticket => ticket.id === id);
    if (!api || !before) return false;
    setError(null);
    const { reason: _reason, priority, ...shown } = patch;
    replaceTicket({
      ...before,
      ...shown,
      ...(priority !== undefined && { priority: priority ?? undefined }),
    } as LocalTicket);
    const result = await api.updateTicket({ id, ...patch });
    if (!result.ok) {
      replaceTicket(before);
      setError(result.error);
      return false;
    }
    if (result.value) replaceTicket(result.value);
    return true;
  }, []);

  const act = useCallback(async <T>(call: () => Promise<LocalLoopsResult<T>>): Promise<T | undefined> => {
    setError(null);
    const result = await call();
    if (!result.ok) {
      setError(result.error);
      return undefined;
    }
    return result.value;
  }, []);

  return { detail, error, clearError: () => setError(null), reload, moveTicket, act };
}
