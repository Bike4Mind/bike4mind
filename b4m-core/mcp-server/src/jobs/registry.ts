import { confirmationJob } from './confirmation';
import type { JobKind } from './types';

// Only `confirmation` is wired; later job kinds register here.
export const JOB_KINDS: Readonly<Record<string, JobKind>> = { [confirmationJob.kind]: confirmationJob };

export interface ParsedJob {
  kind: JobKind;
  id: string;
}

/** Splits `<kind>:<id>` and validates both before anything reaches a transport. Returns an error string on failure. */
export function parseJob(job: string): ParsedJob | string {
  const sep = job.indexOf(':');
  const kind = sep > 0 ? JOB_KINDS[job.slice(0, sep)] : undefined;
  if (!kind)
    return `Unknown job ${JSON.stringify(job.slice(0, 80))}. Job ids look like <kind>:<id>; kinds: ${Object.keys(JOB_KINDS).join(', ')}.`;
  const id = kind.idSchema.safeParse(job.slice(sep + 1));
  return id.success
    ? { kind, id: id.data }
    : `Invalid id for ${kind.kind} job: ${id.error.issues[0]?.message ?? 'rejected'}.`;
}
