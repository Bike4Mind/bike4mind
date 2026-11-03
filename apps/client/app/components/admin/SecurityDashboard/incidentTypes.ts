// Response shapes for the admin Security Dashboard incident view. Shared by the server
// (server/security/incidentSignals.ts, incidentState.ts) and the UI, so keep this file free of
// server-only imports. Every section fails on its own: null values plus a short `error`.

export type IncidentRange = '1h' | '24h' | '7d';

export const INCIDENT_RANGES: readonly IncidentRange[] = ['1h', '24h', '7d'];

/** Totals over the range. null: that query failed; 0: no datapoints. */
export interface IncidentMetricTotals {
  /** Hourly census of completed hours, so the newest hour can lag by up to two hours. */
  successfulSignups: number | null;
  fullGrants: number | null;
  signupCodeSends: number | null;
  apiKeyCreations: number | null;
  oauthSignupsRefused: number | null;
  youngAccountSpendUsd: number | null;
  turnstileMisconfigured: number | null;
  error?: string;
}

export interface IncidentWafTotals {
  allowed: number | null;
  blocked: number | null;
  counted: number | null;
  /** The stage has no WAF on its router; not a failure. */
  notConfigured?: true;
  error?: string;
}

export interface IncidentAlarm {
  /** Alarm name with the `<app>-<stage>-` prefix stripped. */
  name: string;
  /** ISO time the alarm entered ALARM. */
  since: string;
}

export interface IncidentAlarms {
  total: number | null;
  /** Newest first. */
  inAlarm: IncidentAlarm[];
  error?: string;
}

/** `other`: the set is referenced only as an exemption, a rate-rule scope, or under a rule group. */
export type IncidentBlockListAction = 'block' | 'count' | 'other';

export interface IncidentBlockList {
  name: string;
  entries: number;
  action: IncidentBlockListAction;
}

export interface IncidentBlockLists {
  lists: IncidentBlockList[];
  blockerActiveEntries: { value: number; at: string } | null;
  /** The stage has no WAF on its router, so there are no IP sets; not a failure. */
  notConfigured?: true;
  error?: string;
}

export interface IncidentSignals {
  generatedAt: string;
  range: IncidentRange;
  metrics: IncidentMetricTotals;
  waf: IncidentWafTotals;
  alarms: IncidentAlarms;
  blockLists: IncidentBlockLists;
}

export interface IncidentDefenses {
  /** null when settings could not be read. `secretConfigured` is null when the secret could not be read (unknown). */
  turnstile: { enabled: boolean; failClosed: boolean; secretConfigured: boolean | null } | null;
  /** null when the budget is unmetered (setting 0 or unset), or on error. */
  grantBudget: { limit: number; spentToday: number; day: string } | null;
  /** null when the new-account spend caps are off (0), or on error. */
  newAccountSpendCapDays: number | null;
  paymentRisk: {
    alertsEnabled: boolean;
    autoRefundEnabled: boolean;
    linkedAccountActions: boolean;
    /** null when the checkout refusal is off (0). */
    checkoutMaxBlockedAttempts: number | null;
  } | null;
  error?: string;
}

export interface IncidentQueues {
  riskReviewsPending: number | null;
  heldGrants: number | null;
  domainHoldsPending: number | null;
  error?: string;
}

export interface PaymentWindow {
  attempts: number;
  succeeded: number;
  failed: number;
  radarBlocked: number;
  /** Radar risk level elevated or highest. */
  elevatedRisk: number;
  hostingNetwork: number;
  distinctCards: number;
}

export interface IncidentPayments {
  last24h: PaymentWindow | null;
  last7d: PaymentWindow | null;
  error?: string;
}

export interface IncidentState {
  generatedAt: string;
  defenses: IncidentDefenses;
  queues: IncidentQueues;
  payments: IncidentPayments;
}
