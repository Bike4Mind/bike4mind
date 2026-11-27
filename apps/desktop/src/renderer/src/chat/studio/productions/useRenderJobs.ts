import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isRenderInFlight,
  type ProductionRenderJob,
  type ProductionsApi,
  type ProductionsErrorKind,
} from '@shared/productions';
import { describeLibraryError as describeIpcError } from '../../library/useLibraryFeed';
import { nextPollDelay, RENDER_POLL } from './renderPolling';

export type RenderPollStatus = 'loading' | 'polling' | 'idle' | 'stalled';

export interface RenderJobsState {
  jobs: ProductionRenderJob[];
  status: RenderPollStatus;
  error: { kind: ProductionsErrorKind; message: string } | null;
}

/**
 * A production's recent render jobs. Reads them once on open; while any is in flight it re-reads
 * them on a backing-off timer (renderPolling.ts), stopping when every job is terminal, after
 * RENDER_POLL.maxPolls checks, or on unmount. `start` and `refresh` begin a fresh bounded run.
 */
export function useRenderJobs(api: Pick<ProductionsApi, 'renders' | 'render'>, productionId: string) {
  const [state, setState] = useState<RenderJobsState>({ jobs: [], status: 'loading', error: null });
  const [run, setRun] = useState(0);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (attempt: number) => {
      let result: Awaited<ReturnType<typeof api.renders>>;
      try {
        result = await api.renders({ id: productionId });
      } catch (error) {
        result = { ok: false, error: { kind: 'failed', message: describeIpcError(error) } };
      }
      if (!live) return;
      if (!result.ok) {
        // A failed read ends this run; "Check again" starts another, so a down server is never hammered.
        setState(previous => ({ ...previous, status: 'idle', error: result.error }));
        return;
      }
      const jobs = result.value;
      const inFlight = jobs.some(isRenderInFlight);
      const exhausted = attempt + 1 >= RENDER_POLL.maxPolls;
      setState({ jobs, error: null, status: !inFlight ? 'idle' : exhausted ? 'stalled' : 'polling' });
      if (inFlight && !exhausted) timer = setTimeout(() => void check(attempt + 1), nextPollDelay(attempt));
    };
    void check(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, productionId, run]);

  const refresh = useCallback(() => setRun(value => value + 1), []);

  const start = useCallback(
    async (outputIds: string[]): Promise<{ ok: true } | { ok: false; message: string }> => {
      setStarting(true);
      try {
        const result = await api.render({ id: productionId, outputIds });
        if (!result.ok) return { ok: false, message: result.error.message };
        if (mounted.current) {
          setState(previous => ({ ...previous, jobs: [...result.value, ...previous.jobs] }));
          setRun(value => value + 1);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, message: describeIpcError(error) };
      } finally {
        if (mounted.current) setStarting(false);
      }
    },
    [api, productionId]
  );

  return { ...state, starting, refresh, start };
}
