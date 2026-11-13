import { useMemo, useRef, useState } from 'react';
import type { ReferenceCutout } from '@client/app/components/Studio/capabilityFields';
import {
  describeStudioImageCutoutError,
  useCreateStudioImageCutout,
  useStudioImageJobs,
} from '@client/app/hooks/data/studioImageJobs';
import { latchSettledCutouts, resolveCutout, type CutoutRequest } from './referenceCutouts';

/**
 * Background removal per reference, keyed by the original's file id. Turning it on starts a credit-charged cutout
 * job; turning it off only stops using it, so turning it back on reuses a cutout that is running or ready instead of
 * paying again. Only a failed or refused one is retried. The job's progress is read from the gallery list, which the
 * socket keeps current, so there is no second poller; a terminal outcome is latched here once seen.
 */
export function useReferenceCutouts() {
  const [requests, setRequests] = useState<Record<string, CutoutRequest>>({});
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(() => new Set());
  const attempts = useRef(0);
  const createCutout = useCreateStudioImageCutout();
  const jobs = useStudioImageJobs();

  const jobsById = useMemo(
    () => new Map((jobs.data?.pages ?? []).flatMap(page => page.data).map(job => [job.id, job])),
    [jobs.data]
  );

  // Latch each started job's terminal outcome whenever the list changes, so readiness does not depend on the job
  // staying in the loaded pages. Adjusted during render (React's "state from a changed input" pattern).
  const [latchedFor, setLatchedFor] = useState(jobsById);
  if (latchedFor !== jobsById) {
    setLatchedFor(jobsById);
    setRequests(current => latchSettledCutouts(current, jobsById));
  }

  const settleRequest = (fileId: string, attempt: number, request: CutoutRequest) =>
    setRequests(current => {
      const pending = current[fileId];
      return pending?.status === 'starting' && pending.attempt === attempt
        ? { ...current, [fileId]: request }
        : current;
    });

  const resolvedCutout = (fileId: string): ReferenceCutout | undefined => {
    const request = requests[fileId];
    if (!request) return undefined;
    return resolveCutout(request, request.status === 'started' ? jobsById.get(request.jobId) : undefined);
  };

  const setCutoutEnabled = (fileId: string, on: boolean) =>
    setEnabled(current => {
      if (current.has(fileId) === on) return current;
      const next = new Set(current);
      if (on) next.add(fileId);
      else next.delete(fileId);
      return next;
    });

  const toggleCutout = (fileId: string, on: boolean) => {
    setCutoutEnabled(fileId, on);
    if (!on) return;
    const existing = resolvedCutout(fileId);
    if (existing && existing.status !== 'failed') return;
    attempts.current += 1;
    const attempt = attempts.current;
    setRequests(current => ({ ...current, [fileId]: { status: 'starting', attempt } }));
    createCutout.mutateAsync(fileId).then(
      job => settleRequest(fileId, attempt, { status: 'started', jobId: job.id }),
      (error: unknown) =>
        settleRequest(fileId, attempt, { status: 'refused', message: describeStudioImageCutoutError(error) })
    );
  };

  const cutoutOf = (fileId: string): ReferenceCutout | undefined =>
    enabled.has(fileId) ? resolvedCutout(fileId) : undefined;

  return { cutoutOf, toggleCutout };
}
