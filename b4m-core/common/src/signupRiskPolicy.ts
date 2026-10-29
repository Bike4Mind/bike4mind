import { z } from 'zod';

export const SIGNUP_GRANT_RISK_SIGNALS = [
  'datacenter',
  'canonicalEmailCollision',
  'disposableDomain',
  'blockedDomain',
  'challengeVerified',
  'ipSignups',
  'asnSignups',
  'prefixSignups',
] as const;

export type SignupGrantRiskSignal = (typeof SIGNUP_GRANT_RISK_SIGNALS)[number];

const finiteNonnegative = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const ruleSchema = z
  .object({
    signal: z.enum(SIGNUP_GRANT_RISK_SIGNALS),
    comparison: z.enum(['eq', 'gte']),
    threshold: finiteNonnegative,
    weight: finiteNonnegative,
    missing: z.enum(['review', 'score']),
    missingWeight: finiteNonnegative,
  })
  .strict()
  .superRefine((rule, ctx) => {
    const countSignal = rule.signal.endsWith('Signups');
    if (
      (countSignal && !Number.isSafeInteger(rule.threshold)) ||
      (!countSignal && (rule.comparison !== 'eq' || (rule.threshold !== 0 && rule.threshold !== 1)))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid signal comparison' });
    }
  });

export const signupGrantRiskPolicySchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      version: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      rules: z.array(ruleSchema).min(1).max(SIGNUP_GRANT_RISK_SIGNALS.length),
      reducedAt: finiteNonnegative.positive(),
      reviewAt: finiteNonnegative.positive(),
      reducedFraction: z.number().finite().gt(0).lt(1),
    })
    .strict()
    .superRefine((policy, ctx) => {
      if (policy.reviewAt <= policy.reducedAt) {
        ctx.addIssue({ code: 'custom', message: 'Bands must be strictly ordered' });
      }
      if (new Set(policy.rules.map(rule => rule.signal)).size !== policy.rules.length) {
        ctx.addIssue({ code: 'custom', message: 'Signals must be unique' });
      }
      const maximumScore = policy.rules.reduce((sum, rule) => sum + Math.max(rule.weight, rule.missingWeight), 0);
      if (!Number.isSafeInteger(Math.ceil(maximumScore))) {
        ctx.addIssue({ code: 'custom', message: 'Score exceeds numeric bounds' });
      }
    }),
]);

export type SignupGrantRiskPolicy = z.infer<typeof signupGrantRiskPolicySchema>;
