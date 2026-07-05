import { z } from 'zod';
import { EvidenceTierSchema, type EvidenceTier } from './evidence';

/**
 * Adversarial review verdict - the output of a reviewer pass over an Episode.
 *
 * Inherited from q-paper-neutron-scattering's independent reviewer sessions:
 * an agent does not grade its own work. A reviewer reads the episode (claims,
 * scope locks, memory written) with a refuting stance and returns a verdict.
 * Tier advancement is gated on approval - `tierGranted` is the highest tier
 * the reviewer is willing to certify for this work.
 */
export const ReviewVerdictSchema = z.object({
  /**
   * - approved: claims hold up; tierGranted may certify tier advancement
   * - needs-changes: salvageable, but issues must be addressed first
   * - rejected: claims refuted or unsupported
   */
  verdict: z.enum(['approved', 'needs-changes', 'rejected']),
  /** Specific, checkable problems found (empty when approved clean). */
  issues: z.array(z.string()).default([]),
  /** Highest evidence tier the reviewer certifies for this work. */
  tierGranted: EvidenceTierSchema.optional(),
  /** One-paragraph justification of the verdict. */
  summary: z.string().min(1),
});

export type ReviewVerdict = {
  verdict: 'approved' | 'needs-changes' | 'rejected';
  issues: string[];
  tierGranted?: EvidenceTier;
  summary: string;
};
