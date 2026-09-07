import { z } from 'zod';

/**
 * The wire shape of a research configuration's levers, shared by the create and update routes so
 * the two cannot accept different things.
 *
 * Deliberately PERMISSIVE on ranges: every bound is enforced by `normalizeResearchLevers`, which
 * clamps rather than rejects. Duplicating the numbers here would mean a route refuses a value the
 * service would happily have clamped, and - worse - the two copies would drift the first time a
 * bound moves. What this schema is for is TYPE safety at the boundary: a string where a number
 * belongs is a client bug, and the clamps cannot catch it.
 */
export const ResearchLeversInput = z.object({
  query: z.string().optional(),
  model: z.string().optional(),
  maxResults: z.number().optional(),
  maxProposals: z.number().optional(),
  // Nullable so a client can CLEAR the window. The normalizer reads 0 and null alike as "no
  // recency constraint", and null is what the UI sends when the field is emptied.
  recencyDays: z.number().nullable().optional(),
  allowedDomains: z.array(z.string()).optional(),
  blockedDomains: z.array(z.string()).optional(),
  minRelevance: z.number().optional(),
  costCeilingMicroUsd: z.number().optional(),
  proposedTags: z.array(z.string()).optional(),
});

export type ResearchLeversInputShape = z.infer<typeof ResearchLeversInput>;
