import { z } from 'zod';
import { SIGNUP_RISK_SIGNALS } from './settings';
import { SIGNUP_RISK_REVIEW_STATES } from '../types/entities/UserTypes';

/**
 * Behavioral evidence about an account, summarized from server-side records only (auth events,
 * API key rows, the usage ledger, execution state, the auth audit log). Shadow-only: it is stored
 * apart from IUser.riskScore and nothing reads it to set reviewState, so collecting it can never
 * hold an account's AI access.
 *
 * Every fact says how it was known. `observed` carries a value plus how many source records backed
 * it and the newest one; `missing` means the source had nothing to say (an absent fact is unknown,
 * never clean); `failed` means the read itself errored. Client clocks and client-reported identity
 * never enter: every timestamp is a server write time.
 *
 * Retention and deletion: the summary lives on the user document (IUser.riskEvidence), is replaced
 * whole on each refresh and is removed with the account. It holds counts and booleans only - no IPs,
 * fingerprints, prompt or document text, keystrokes or pointer data. Telemetry classification:
 * admin-only abuse signal, same as signupMeta; toSafeUser strips it for the account holder.
 */
export const RISK_EVIDENCE_VERSION = 1;

/** Furthest back a refresh looks. AuthEvent rows expire at 90 days, so a longer window would read short. */
export const RISK_EVIDENCE_WINDOW_DAYS = 30;

/** Source rows one bounded scan reads; a scan that hits it is `truncated`, so its count is a floor. */
export const RISK_EVIDENCE_SCAN_LIMIT = 200;

/** Usage ledger rows one refresh reads; higher than the auth scans because a busy account logs many per day. */
export const RISK_EVIDENCE_USAGE_SCAN_LIMIT = 5000;

export const RISK_EVIDENCE_TRIGGERS = [
  'signup',
  'login',
  'email_verified',
  'api_key_created',
  'completion',
  'sweep',
] as const;
export const riskEvidenceTriggerSchema = z.enum(RISK_EVIDENCE_TRIGGERS);
export type RiskEvidenceTrigger = z.infer<typeof riskEvidenceTriggerSchema>;

export const RISK_EVIDENCE_PROVENANCES = [
  'signup_request',
  'auth_events',
  'api_key_records',
  'usage_ledger',
  'execution_state',
  'auth_audit_log',
] as const;
const provenanceSchema = z.enum(RISK_EVIDENCE_PROVENANCES);

export const RISK_EVIDENCE_MISSING_REASONS = ['not_captured', 'no_activity'] as const;

// Dates arrive as Date from Mongo and as ISO strings over JSON; coerce accepts both.
const dateSchema = z.coerce.date();

function factSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('observed'),
      provenance: provenanceSchema,
      value,
      sampleCount: z.number().int().nonnegative(),
      /** Newest source record behind the value; null for a point-in-time sample. */
      latestAt: dateSchema.nullable(),
      /** The scan hit RISK_EVIDENCE_SCAN_LIMIT, so counts are lower bounds. */
      truncated: z.boolean(),
    }),
    z.object({
      status: z.literal('missing'),
      provenance: provenanceSchema,
      reason: z.enum(RISK_EVIDENCE_MISSING_REASONS),
    }),
    z.object({
      status: z.literal('failed'),
      provenance: provenanceSchema,
      error: z.string().max(200),
    }),
  ]);
}

const count = z.number().int().nonnegative();

export const riskEvidenceFactsSchema = z.object({
  signupNetwork: factSchema(
    z.object({ isDatacenter: z.boolean().nullable(), asnKnown: z.boolean(), challengeVerified: z.boolean() })
  ),
  edgeFingerprint: factSchema(z.object({ ja4Present: z.boolean() })),
  wafSignals: factSchema(z.object({ anonIp: z.boolean(), botSignal: z.boolean() })),
  authActivity: factSchema(z.object({ logins: count, signups: count, distinctIps: count, distinctNetworks: count })),
  apiKeys: factSchema(z.object({ created: count, minutesToFirstKey: z.number().nonnegative().nullable() })),
  usage: factSchema(z.object({ events: count, completed: count, failed: count, creditsSpent: z.number() })),
  concurrency: factSchema(z.object({ activeAgentExecutions: count })),
  sensitiveActions: factSchema(
    z.object({
      stepUpFailed: count,
      stepUpSucceeded: count,
      emailChangeFailed: count,
      mfaDisabled: count,
      sessionReuseRevoked: count,
    })
  ),
});
export type RiskEvidenceFacts = z.infer<typeof riskEvidenceFactsSchema>;
export type RiskEvidenceFactName = keyof RiskEvidenceFacts;
export type RiskEvidenceFact<K extends RiskEvidenceFactName = RiskEvidenceFactName> = RiskEvidenceFacts[K];

export const riskEvidenceSummarySchema = z.object({
  version: z.literal(RISK_EVIDENCE_VERSION),
  /** Server time the sources were read; a stored summary is only replaced by a later one. */
  computedAt: dateSchema,
  window: z.object({ from: dateSchema, to: dateSchema }),
  trigger: riskEvidenceTriggerSchema,
  facts: riskEvidenceFactsSchema,
});
export type RiskEvidenceSummary = z.infer<typeof riskEvidenceSummarySchema>;

/** Refresh bookkeeping, kept beside the summary so a failed refresh is visible to admins. */
export const riskEvidenceRefreshStateSchema = z.object({
  /** Set when a refresh is queued, cleared when one starts; requests meanwhile are deduplicated. */
  pendingSince: dateSchema.nullable(),
  lastTrigger: riskEvidenceTriggerSchema.nullable(),
  lastFailureAt: dateSchema.nullable(),
  lastFailure: z.string().max(200).nullable(),
});
export type RiskEvidenceRefreshState = z.infer<typeof riskEvidenceRefreshStateSchema>;

export const riskEvidenceRecordSchema = z.object({
  summary: riskEvidenceSummarySchema.nullable(),
  refresh: riskEvidenceRefreshStateSchema.nullable(),
});
export type RiskEvidenceRecord = z.infer<typeof riskEvidenceRecordSchema>;

/** GET /api/admin/users/[userId]/risk-evidence. */
export const adminRiskEvidenceViewSchema = z.object({
  riskScore: z
    .object({
      score: z.number(),
      signals: z.array(z.object({ signal: z.enum(SIGNUP_RISK_SIGNALS), points: z.number(), reason: z.string() })),
      computedAt: dateSchema,
      reviewState: z.enum(SIGNUP_RISK_REVIEW_STATES),
    })
    .nullable(),
  /** Null when no summary was stored yet, or the stored one is an older version this build cannot read. */
  evidence: riskEvidenceSummarySchema.nullable(),
  /** True when a summary is stored but this build cannot read it, so the UI does not report "none collected". */
  evidenceUnreadable: z.boolean(),
  refresh: riskEvidenceRefreshStateSchema.nullable(),
});
export type AdminRiskEvidenceView = z.infer<typeof adminRiskEvidenceViewSchema>;

/** SQS message for the riskEvidenceQueue; the userId is all a refresh needs, so replays are harmless. */
export const riskEvidenceRefreshMessageSchema = z.object({
  kind: z.literal('refresh'),
  userId: z.string().regex(/^[a-f0-9]{24}$/i),
  trigger: riskEvidenceTriggerSchema,
  /** When the refresh was requested, for the lag metric. */
  requestedAt: dateSchema,
});
export type RiskEvidenceRefreshMessage = z.infer<typeof riskEvidenceRefreshMessageSchema>;

/** What the completion.completed rule's input transformer sends: the user id only, never the event's prompt. */
export const riskEvidenceCompletionMessageSchema = z.object({
  kind: z.literal('completion'),
  userId: z.string().regex(/^[a-f0-9]{24}$/i),
});
export type RiskEvidenceCompletionMessage = z.infer<typeof riskEvidenceCompletionMessageSchema>;
