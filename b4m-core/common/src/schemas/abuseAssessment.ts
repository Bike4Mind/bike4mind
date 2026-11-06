import { z } from 'zod';
import { DECISION_MODEL_IDS } from '../decisions/catalog';
import { RISK_EVIDENCE_MISSING_REASONS, riskEvidenceFactValueSchemas } from './riskEvidence';
import { SHADOW_DETECTION_VERDICTS, SHADOW_DETECTORS } from './shadowDetection';

/**
 * Advisory abuse assessments: a Decisions model's judgment of a shadow detection, made from an
 * allowlisted, pseudonymous feature summary (counts and flags; no IP, email, prompt or document
 * text) and stored for admin review next to the detection. The assessment itself writes nothing to
 * an account; automated containment (schemas/autoContainment.ts, autoContainmentConfig) is the one
 * reader that may act on it, and only in enforce mode. Produced by
 * apps/client/server/security/abuseAssessment/abuseAssessment.ts; stored in the AbuseAssessment collection.
 */

/**
 * Bump when the question, its choices or the summary's meaning changes; cached results key on it.
 * v2 asks the reason questions (ABUSE_ASSESSMENT_REASON_KEYS) alongside the judgment.
 */
export const ABUSE_ASSESSMENT_POLICY_VERSION = 2;

/**
 * The feature summary's shape. v1 carried the stored risk evidence per account; v2 adds each
 * account's profile (signup network and method, email shape, time to two-factor and to first spend,
 * spend by model, linked accounts). Stored v1 summaries stay readable through
 * abuseAssessmentStoredItemSchema, which does not re-validate them.
 */
export const ABUSE_ASSESSMENT_EVIDENCE_VERSION = 2;

/** What the model may answer. */
export const ABUSE_ASSESSMENT_JUDGMENTS = ['abuse', 'legitimate_automation', 'insufficient_evidence'] as const;
export type AbuseAssessmentJudgment = (typeof ABUSE_ASSESSMENT_JUDGMENTS)[number];

/** A stored result: a judgment, or unknown when no usable answer came back. */
export const ABUSE_ASSESSMENT_RESULTS = [...ABUSE_ASSESSMENT_JUDGMENTS, 'unknown'] as const;
export type AbuseAssessmentResult = (typeof ABUSE_ASSESSMENT_RESULTS)[number];

/** Why a result is unknown. Diagnostics only; never vendor text. */
export const ABUSE_ASSESSMENT_FAILURE_CODES = [
  'provider_not_configured',
  'model_unavailable',
  'provider_overloaded',
  'provider_rejected',
  'provider_error',
  'malformed_response',
  'refused',
  'invalid_request',
] as const;
export type AbuseAssessmentFailureCode = (typeof ABUSE_ASSESSMENT_FAILURE_CODES)[number];

/** strong_link: assessed at signup by the strong-link rule (autoContainment/strongLink.ts), not the sweep. */
export const ABUSE_ASSESSMENT_TRIGGERS = ['admin', 'sweep', 'strong_link'] as const;
export type AbuseAssessmentTrigger = (typeof ABUSE_ASSESSMENT_TRIGGERS)[number];

/** Input caps: accounts summarized per detection, signals copied, and the serialized summary size. */
export const ABUSE_ASSESSMENT_MAX_ACCOUNTS = 10;
export const ABUSE_ASSESSMENT_MAX_SIGNALS = 20;
// Sized for ten accounts with evidence and a v2 profile each.
export const ABUSE_ASSESSMENT_MAX_SUMMARY_CHARS = 24_000;

/** Unknown results are attempted at most this many times per evidence version. */
export const ABUSE_ASSESSMENT_MAX_ATTEMPTS = 3;

// Keys are code-authored identifiers; the pattern keeps any free text out of the provider payload.
const featureKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const accountRefSchema = z.string().regex(/^acct_\d{1,3}$/);
const finiteNumber = z.number().finite();

function projectedFactSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('observed'),
      value,
      sampleCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    z.strictObject({ status: z.literal('missing'), reason: z.enum(RISK_EVIDENCE_MISSING_REASONS) }),
    z.strictObject({ status: z.literal('failed') }),
  ]);
}

const v = riskEvidenceFactValueSchemas;

/** A risk evidence summary without provenance, timestamps or error text. */
export const abuseAssessmentAccountEvidenceSchema = z.strictObject({
  signupNetwork: projectedFactSchema(v.signupNetwork),
  edgeFingerprint: projectedFactSchema(v.edgeFingerprint),
  wafSignals: projectedFactSchema(v.wafSignals),
  authActivity: projectedFactSchema(v.authActivity),
  apiKeys: projectedFactSchema(v.apiKeys),
  usage: projectedFactSchema(v.usage),
  concurrency: projectedFactSchema(v.concurrency),
  sensitiveActions: projectedFactSchema(v.sensitiveActions),
});
export type AbuseAssessmentAccountEvidence = z.infer<typeof abuseAssessmentAccountEvidenceSchema>;

/** Model ids are catalog identifiers recorded server-side; the pattern still keeps free text out. */
const modelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/);
const nonNegativeInt = z.number().int().nonnegative();

export const ABUSE_ASSESSMENT_SIGNUP_METHODS = ['otc', 'oauth', 'email', 'other'] as const;
export const ABUSE_ASSESSMENT_MAX_PROFILE_MODELS = 5;

/**
 * Account-level facts beside the stored evidence (v2). Flags, durations and counts only: the
 * signup network is reduced to hosting/anonymous flags, the address to its shape, and linked
 * accounts to counts per shared trait.
 */
export const abuseAssessmentAccountProfileSchema = z.strictObject({
  signupMethod: z.enum(ABUSE_ASSESSMENT_SIGNUP_METHODS),
  signupNetwork: z.strictObject({
    asnKnown: z.boolean(),
    /** Datacenter ASN or WAF anonymous-IP label; null when neither is known. */
    hosting: z.boolean().nullable(),
    datacenter: z.boolean().nullable(),
    /** WAF anonymous-IP (VPN, proxy, relay) label; null when the WAF did not check. */
    anonymousIp: z.boolean().nullable(),
    ja4Present: z.boolean(),
  }),
  email: z
    .strictObject({
      plusAddressed: z.boolean(),
      randomLookingPlusTag: z.boolean(),
      generatedLocalPart: z.boolean(),
      consumerMailDomain: z.boolean(),
    })
    .nullable(),
  /** Minutes from signup to setting up two-factor that is now enabled; null when not enabled. */
  minutesToTwoFactor: nonNegativeInt.nullable(),
  /** Minutes from signup to the first credit spend; null with no spend in the lookback. */
  minutesToFirstSpend: nonNegativeInt.nullable(),
  spend: z
    .strictObject({
      totalCredits: z.number().finite().nonnegative(),
      byModel: z
        .array(
          z.strictObject({
            /** null for spend recorded without a model. */
            model: modelIdSchema.nullable(),
            creditShare: z.number().min(0).max(1),
            events: nonNegativeInt,
            creditsPerEvent: z.number().finite().nonnegative(),
          })
        )
        .max(ABUSE_ASSESSMENT_MAX_PROFILE_MODELS),
    })
    .nullable(),
  /**
   * Other accounts created within the strong-link window of this one that share a trait with it.
   * Per-trait counts overlap; `total` counts each account once. `truncated` when the scan hit its cap.
   */
  linkedAccounts: z
    .strictObject({
      windowHours: nonNegativeInt,
      total: nonNegativeInt,
      blocked: nonNegativeInt,
      sharedSignupIp: nonNegativeInt,
      sharedJa4: nonNegativeInt,
      sharedMailbox: nonNegativeInt,
      sharedMailDomain: nonNegativeInt,
      truncated: z.boolean(),
    })
    .nullable(),
});
export type AbuseAssessmentAccountProfile = z.infer<typeof abuseAssessmentAccountProfileSchema>;

export const abuseAssessmentAccountSchema = z.strictObject({
  /** Pseudonymous and per assessment: acct_1 here says nothing about acct_1 elsewhere. */
  ref: accountRefSchema,
  accountAgeHours: z.number().int().nonnegative().nullable(),
  /** Hours between the evidence being computed and the detection; null with no evidence. */
  evidenceAgeHours: z.number().int().nullable(),
  evidence: abuseAssessmentAccountEvidenceSchema.nullable(),
  /** Null when the account could not be read. */
  profile: abuseAssessmentAccountProfileSchema.nullable(),
});
export type AbuseAssessmentAccount = z.infer<typeof abuseAssessmentAccountSchema>;

/**
 * Group-level evidence (account clustering) as an optional input. A producer maps its own groups
 * into this shape; members are referenced only by the assessment's own account refs.
 */
export const abuseAssessmentGroupEvidenceSchema = z.strictObject({
  source: featureKeySchema,
  version: z.number().int().positive(),
  memberCount: z.number().int().nonnegative(),
  memberRefs: z.array(accountRefSchema).max(ABUSE_ASSESSMENT_MAX_ACCOUNTS),
  signals: z
    .array(z.strictObject({ key: featureKeySchema, value: z.union([finiteNumber, z.boolean(), z.null()]) }))
    .max(ABUSE_ASSESSMENT_MAX_SIGNALS),
});
export type AbuseAssessmentGroupEvidence = z.infer<typeof abuseAssessmentGroupEvidenceSchema>;

/** Exactly what the provider receives. Strict, so a field added upstream never rides along. */
export const abuseAssessmentFeatureSummarySchema = z.strictObject({
  evidenceVersion: z.literal(ABUSE_ASSESSMENT_EVIDENCE_VERSION),
  detection: z.strictObject({
    detector: z.enum(SHADOW_DETECTORS),
    detectorPolicyVersion: z.number().int(),
    windowMinutes: finiteNumber.nullable(),
    hostingNetwork: z.boolean().nullable(),
    signals: z
      .array(
        z.strictObject({ key: featureKeySchema, observed: finiteNumber.nullable(), threshold: finiteNumber.nullable() })
      )
      .max(ABUSE_ASSESSMENT_MAX_SIGNALS),
  }),
  accounts: z.array(abuseAssessmentAccountSchema).max(ABUSE_ASSESSMENT_MAX_ACCOUNTS),
  /** Accounts on the detection beyond the cap. */
  accountsOmitted: z.number().int().nonnegative(),
  group: abuseAssessmentGroupEvidenceSchema.nullable(),
});
export type AbuseAssessmentFeatureSummary = z.infer<typeof abuseAssessmentFeatureSummarySchema>;

/**
 * The evidence factors the model is asked about, as yes/no questions in the same call as the
 * judgment. The provider returns only probabilities, so a reason is a fixed key the admin UI words
 * itself: nothing the model writes is stored or shown. Questions live in abuseAssessment.ts.
 */
export const ABUSE_ASSESSMENT_REASON_KEYS = [
  'anonymizedNetwork',
  'generatedLookingEmail',
  'rushedOnboarding',
  'linkedAccounts',
  'concentratedExpensiveSpend',
  'signupBurst',
  'ordinaryUse',
] as const;
export type AbuseAssessmentReasonKey = (typeof ABUSE_ASSESSMENT_REASON_KEYS)[number];
/** At most this many reasons are stored per assessment, strongest first. */
export const ABUSE_ASSESSMENT_MAX_REASONS = 3;

export const abuseAssessmentReasonSchema = z.object({
  key: z.enum(ABUSE_ASSESSMENT_REASON_KEYS),
  probability: z.number().min(0).max(1),
});
export type AbuseAssessmentReason = z.infer<typeof abuseAssessmentReasonSchema>;

export const abuseAssessmentProbabilitySchema = z.object({
  value: z.enum(ABUSE_ASSESSMENT_JUDGMENTS),
  probability: z.number(),
});

export const abuseAssessmentItemSchema = z.object({
  id: z.string(),
  detectionId: z.string(),
  result: z.enum(ABUSE_ASSESSMENT_RESULTS),
  /** The model's distribution; empty for unknown. Not calibrated for abuse; read it as a hint. */
  probabilities: z.array(abuseAssessmentProbabilitySchema),
  confidence: z.number().nullable(),
  /** The factors the model found most present, strongest first; empty for unknown and policy v1 rows. */
  reasons: z.array(abuseAssessmentReasonSchema).max(ABUSE_ASSESSMENT_MAX_REASONS),
  /** The configured model, and the version the provider reported answering with. */
  model: z.enum(DECISION_MODEL_IDS),
  modelVersion: z.string().nullable(),
  policyVersion: z.number().int(),
  evidenceVersion: z.number().int(),
  evidenceHash: z.string(),
  featureSummary: abuseAssessmentFeatureSummarySchema,
  failure: z.enum(ABUSE_ASSESSMENT_FAILURE_CODES).nullable(),
  attempts: z.number().int(),
  costUsd: z.number(),
  trigger: z.enum(ABUSE_ASSESSMENT_TRIGGERS),
  requestedBy: z.string().nullable(),
  assessedAt: z.date(),
});
export type AbuseAssessmentItem = z.infer<typeof abuseAssessmentItemSchema>;

export const abuseAssessmentListQuerySchema = z.object({
  detectionId: z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id'),
});

/**
 * An assessment as listed back. Rows are kept 365 days and outlive the evidence version and model
 * catalog they were made under, so the summary and model are returned as recorded rather than
 * re-validated against today's schema.
 */
export const abuseAssessmentStoredItemSchema = abuseAssessmentItemSchema.extend({
  model: z.string(),
  featureSummary: z.record(z.string(), z.unknown()),
});
export type AbuseAssessmentStoredItem = z.infer<typeof abuseAssessmentStoredItemSchema>;

export const abuseAssessmentListSchema = z.object({ data: z.array(abuseAssessmentStoredItemSchema) });
export type AbuseAssessmentList = z.infer<typeof abuseAssessmentListSchema>;

export const abuseAssessmentRunRequestSchema = z.object({
  detectionId: z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id'),
});

/** Why no assessment was produced; distinct from an unknown result, which is stored. */
export const ABUSE_ASSESSMENT_SKIP_REASONS = [
  'disabled',
  'no_model',
  'model_not_callable',
  'budget_exhausted',
  'call_cap_reached',
  'busy',
  'in_flight',
  'attempts_exhausted',
  'detection_not_found',
  /** The detector records its own Decisions verdict (SELF_ASSESSED_SHADOW_DETECTORS). */
  'self_assessed',
  /** A replay ran out of its request time; rerun the remaining examples. */
  'time_budget',
] as const;
export type AbuseAssessmentSkipReason = (typeof ABUSE_ASSESSMENT_SKIP_REASONS)[number];

export const abuseAssessmentRunResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('assessed'), cached: z.boolean(), item: abuseAssessmentItemSchema }),
  z.object({ status: z.literal('skipped'), reason: z.enum(ABUSE_ASSESSMENT_SKIP_REASONS) }),
]);
export type AbuseAssessmentRunResponse = z.infer<typeof abuseAssessmentRunResponseSchema>;

/** Replay bounds: a fixed labeled set, run once per candidate model. */
export const ABUSE_ASSESSMENT_REPLAY_MAX_EXAMPLES = 50;
export const ABUSE_ASSESSMENT_REPLAY_MAX_MODELS = 3;

export const abuseAssessmentReplayRequestSchema = z.object({
  detectionIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i, 'Not a valid id'))
    .min(1)
    .max(ABUSE_ASSESSMENT_REPLAY_MAX_EXAMPLES),
  models: z.array(z.enum(DECISION_MODEL_IDS)).min(1).max(ABUSE_ASSESSMENT_REPLAY_MAX_MODELS),
});

/** One example under one model. `label` is the detection's human verdict, null if ungraded. */
export const abuseAssessmentReplayRowSchema = z.object({
  exampleId: z.string(),
  label: z.enum(SHADOW_DETECTION_VERDICTS).nullable(),
  model: z.enum(DECISION_MODEL_IDS),
  result: z.enum(ABUSE_ASSESSMENT_RESULTS),
  probabilities: z.array(abuseAssessmentProbabilitySchema),
  confidence: z.number().nullable(),
  failure: z.enum(ABUSE_ASSESSMENT_FAILURE_CODES).nullable(),
});
export type AbuseAssessmentReplayRow = z.infer<typeof abuseAssessmentReplayRowSchema>;

export const abuseAssessmentReplayResponseSchema = z.object({
  status: z.enum(['completed', 'stopped']),
  /** Why the run stopped early; the rows before it are still returned. */
  reason: z.enum(ABUSE_ASSESSMENT_SKIP_REASONS).nullable(),
  /** Requested ids that matched no detection. */
  missing: z.array(z.string()),
  rows: z.array(abuseAssessmentReplayRowSchema),
});
export type AbuseAssessmentReplayResponse = z.infer<typeof abuseAssessmentReplayResponseSchema>;
