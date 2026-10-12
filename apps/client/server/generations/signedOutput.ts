import type { GenerationOutputAvailability } from '@bike4mind/common';

// Short enough that a leaked URL dies quickly; clients re-read the job (which re-signs) for a fresh one.
export const OUTPUT_URL_TTL_SECONDS = 900;

/** Where a job's store step put the output bytes; every kind's job output carries these fields. */
export type StoredOutputRef = { location: 'files' | 'generated'; s3Key: string; fileId?: string };

/** A url only when the output is serveable; otherwise why not (see signOutputUrl's moderation gate). */
export type SignedOutput =
  { availability: 'ready'; url: string } | { availability: Exclude<GenerationOutputAvailability, 'ready'> };

export type SignOutputUrl = (output: StoredOutputRef, expiresInSeconds: number) => Promise<SignedOutput>;

export type JobMapperDeps = { sign: SignOutputUrl; now: () => Date };
