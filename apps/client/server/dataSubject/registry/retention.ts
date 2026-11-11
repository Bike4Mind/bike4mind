import type { RetentionPeriod } from '../types';

/**
 * Shared reasons and periods for `retain` entries. A period here is policy: changing one changes the
 * erasure dry run for every record that uses it. Periods enforced by a TTL index are declared per
 * entry with `expiresAfterTtl`, because the index on the model is what decides them.
 */

type RetentionBasis = { reason: string; retention: RetentionPeriod };

export function expiresAfterTtl(field: string, days: number): RetentionPeriod {
  return { expiresBy: 'ttlIndex', field, days };
}

// 10 years covers the longest common statutory bookkeeping periods, so one period serves every jurisdiction.
export const FINANCIAL_RECORD = {
  reason: 'Financial record kept for accounting and tax obligations (GDPR Art. 17(3)(b))',
  retention: { expiresBy: 'policy', years: 10, from: 'the end of the financial year the record belongs to' },
} as const satisfies RetentionBasis;

export const PAYMENT_DISPUTE = {
  reason: 'Payment dispute kept to establish and defend a legal claim against the chargeback (GDPR Art. 17(3)(e))',
  retention: {
    expiresBy: 'condition',
    until: 'the dispute is closed and no further claim on it can be brought, then the financial-record period applies',
  },
} as const satisfies RetentionBasis;

const ACCOUNTABILITY_RETENTION = {
  expiresBy: 'policy',
  years: 7,
  from: 'the date of the action recorded',
} as const satisfies RetentionPeriod;

export const AUDIT_LOG = {
  reason:
    'Tamper-proof administrative audit record kept for security accountability (legitimate interest, GDPR Art. 6(1)(f))',
  retention: ACCOUNTABILITY_RETENTION,
} as const satisfies RetentionBasis;

export const ADMIN_NOTE = {
  reason:
    'Administrative case note kept as a tamper-proof accountability record (legitimate interest, GDPR Art. 6(1)(f))',
  retention: ACCOUNTABILITY_RETENTION,
} as const satisfies RetentionBasis;

export const CATALOG_PUBLICATION = {
  reason: 'Immutable record of which administrator published a catalog version, kept for accountability',
  retention: ACCOUNTABILITY_RETENTION,
} as const satisfies RetentionBasis;

export const SAFETY_INCIDENT = {
  reason: 'Safety incident kept for legal reporting obligations and to prevent repeat abuse (GDPR Art. 17(3)(b), (e))',
  retention: ACCOUNTABILITY_RETENTION,
} as const satisfies RetentionBasis;

export const EMAIL_SUPPRESSION = {
  reason: 'Suppression record: keeps the address from being mailed again after an objection (Art. 21).',
  retention: { expiresBy: 'condition', until: 'the person withdraws the objection by subscribing again' },
} as const satisfies RetentionBasis;

// `CreditGrantIdentityClaim` refuses a TTL index at startup: an expired claim would re-allow the grant.
export const SIGNUP_GRANT_CLAIM = {
  reason: 'Abuse-prevention record that stops a repeat signup credit grant (legitimate interest, GDPR Art. 6(1)(f))',
  retention: { expiresBy: 'condition', until: 'signup credit grants are no longer offered' },
} as const satisfies RetentionBasis;
