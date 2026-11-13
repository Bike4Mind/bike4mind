import { z } from 'zod';
import { ANALYTICS_ACCOUNTS } from './analyticsOverview';

export const ADOPTION_FEATURES = ['chat', 'image_generation', 'image_edit'] as const;
export const ADOPTION_LABELS: Record<(typeof ADOPTION_FEATURES)[number], string> = {
  chat: 'Chat',
  image_generation: 'Image generation',
  image_edit: 'Image editing',
};
export const ADOPTION_CLIENTS = ['all', 'web', 'cli', 'api', 'agent', 'unknown'] as const;
export const featureAdoptionQuerySchema = z.object({
  accounts: z.enum(ANALYTICS_ACCOUNTS).default('external'),
  client: z.enum(ADOPTION_CLIENTS).default('all'),
  days: z.coerce
    .number()
    .int()
    .refine(value => [7, 28, 90].includes(value))
    .default(7),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type FeatureAdoptionQuery = z.infer<typeof featureAdoptionQuerySchema>;

const contributionSchema = z.object({
  userId: z.string(),
  operations: z.number().int().nonnegative(),
  previousOperations: z.number().int().nonnegative(),
});
const featureSchema = z.object({
  feature: z.enum(ADOPTION_FEATURES),
  label: z.string(),
  successfulUsers: z.number().int().nonnegative(),
  previousUsers: z.number().int().nonnegative().nullable(),
  userChange: z.number().int().nullable(),
  successfulOperations: z.number().int().nonnegative(),
  repeatUsers: z.number().int().nonnegative().nullable(),
  repeatDenominator: z.number().int().nonnegative().nullable(),
  users: z.array(contributionSchema),
});
export const featureAdoptionResponseSchema = z.object({
  query: featureAdoptionQuerySchema,
  window: z.object({ from: z.string(), to: z.string(), previousFrom: z.string(), previousTo: z.string() }),
  coverage: z.literal('unknown'),
  features: z.array(featureSchema),
});
export type FeatureAdoption = z.infer<typeof featureAdoptionResponseSchema>;
export type AdoptionFeature = FeatureAdoption['features'][number];

export function adoptionQueryParams(query: FeatureAdoptionQuery): string {
  return new URLSearchParams({
    accounts: query.accounts,
    client: query.client,
    days: String(query.days),
    ...(query.end ? { end: query.end } : {}),
  }).toString();
}
