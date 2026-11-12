import { useMemo, useRef, useState } from 'react';
import type { ReferenceCutout } from '@client/app/components/Studio/capabilityFields';
import {
  describeStudioImageCutoutError,
  useCreateStudioImageCutout,
  useStudioImageJobs,
} from '@client/app/hooks/data/studioImageJobs';
import { resolveCutout, type CutoutRequest } from './referenceCutouts';

/**
 * Background removal per reference, keyed by the original's file id. Turning it on starts a credit-charged cutout
 * job; turning it off forgets it here (the cutout stays in Files). The job's progress is read from the gallery list,
 * which the socket keeps current, so there is no second poller.
 */
export function useReferenceCutouts() {
  const [requests, setRequests] = useState<Record<string, CutoutRequest>>({});
  const attempts = useRef(0);
  const createCutout = useCreateStudioImageCutout();
  const jobs = useStudioImageJobs();

  const jobsById = useMemo(
    () => new Map((jobs.data?.pages ?? []).flatMap(page => page.data).map(job => [job.id, job])),
    [jobs.data]
  );

  const setRequest = (fileId: string, request: CutoutRequest | undefined) =>
    setRequests(current => {
      const { [fileId]: _dropped, ...rest } = current;
      return request ? { ...rest, [fileId]: request } : rest;
    });

  const settleRequest = (fileId: string, attempt: number, request: CutoutRequest) =>
    setRequests(current => {
      const pending = current[fileId];
      return pending?.status === 'starting' && pending.attempt === attempt
        ? { ...current, [fileId]: request }
        : current;
    });

  const toggleCutout = (fileId: string, on: boolean) => {
    if (!on) return setRequest(fileId, undefined);
    attempts.current += 1;
    const attempt = attempts.current;
    setRequest(fileId, { status: 'starting', attempt });
    createCutout.mutateAsync(fileId).then(
      job => settleRequest(fileId, attempt, { status: 'started', jobId: job.id }),
      (error: unknown) =>
        settleRequest(fileId, attempt, { status: 'refused', message: describeStudioImageCutoutError(error) })
    );
  };

  const cutoutOf = (fileId: string): ReferenceCutout | undefined => {
    const request = requests[fileId];
    if (!request) return undefined;
    return resolveCutout(request, request.status === 'started' ? jobsById.get(request.jobId) : undefined);
  };

  return { cutoutOf, toggleCutout };
}
