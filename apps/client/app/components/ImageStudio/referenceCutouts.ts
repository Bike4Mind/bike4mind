import type { CapabilityFix, ReferenceCutout, ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import type { StudioImageJob } from '@client/app/hooks/data/studioImageJobs';
import { isTerminalGenerationState } from '@client/app/hooks/data/generationJobPolling';

/** Where one reference's background removal stands on the client, before the job's own state takes over. */
export type CutoutRequest =
  // `attempt` ties the create's reply to this toggle, so a reply for one the user turned off meanwhile is dropped.
  | { status: 'starting'; attempt: number }
  | { status: 'started'; jobId: string }
  | { status: 'refused'; message: string };

const FAILED_MESSAGE = 'Background removal failed. Turn it off to use the original, or try again.';
const NOT_IN_FILES_MESSAGE = 'The cutout could not be added to your Files. Turn it off to use the original.';

/** The chip's view of a cutout, from the request and (once started) its job as the gallery list holds it. */
export function resolveCutout(request: CutoutRequest, job: StudioImageJob | undefined): ReferenceCutout {
  if (request.status === 'starting') return { status: 'pending' };
  if (request.status === 'refused') return { status: 'failed', message: request.message };
  // Not in the list yet, live, or succeeded before the refetch brings its output.
  if (!job || !isTerminalGenerationState(job.state) || (job.state === 'succeeded' && job.output === null)) {
    return { status: 'pending' };
  }
  if (job.state !== 'succeeded') return { status: 'failed', message: job.error?.message ?? FAILED_MESSAGE };
  return job.output?.fileId
    ? { status: 'ready', fileId: job.output.fileId }
    : { status: 'failed', message: NOT_IN_FILES_MESSAGE };
}

/** What a reference sends: its cutout once ready, else the original. */
export const referenceFileIdToSend = (file: ReferenceFile): string =>
  file.cutout?.status === 'ready' ? file.cutout.fileId : file.fileId;

/**
 * Why Generate waits on the references' cutouts: one still running (no fix; it finishes on its own) or one that
 * failed (fix: send the original). Null when every cutout is ready or off.
 */
export function referenceCutoutProblem(
  files: readonly ReferenceFile[],
  toggleCutout: (fileId: string, on: boolean) => void
): { invalidReason: string; fix?: CapabilityFix } | null {
  const failed = files.find(file => file.cutout?.status === 'failed');
  if (failed?.cutout?.status === 'failed') {
    return {
      invalidReason: `${failed.fileName}: ${failed.cutout.message}`,
      fix: { label: 'Use the original', apply: () => toggleCutout(failed.fileId, false) },
    };
  }
  if (files.some(file => file.cutout?.status === 'pending')) {
    return { invalidReason: 'Removing the background from a reference. Generate is available once it is ready.' };
  }
  return null;
}
