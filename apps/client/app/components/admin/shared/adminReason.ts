import {
  ADMIN_ACTION_REASON_MAX_LENGTH,
  ADMIN_ACTION_REASON_MIN_LENGTH,
  isValidAdminActionReason,
} from '@bike4mind/common';

/**
 * Preset reasons per audited action. A preset alone is a complete reason, so every label must
 * satisfy the shared `adminActionReason` rule unchanged; `adminAudit.test.ts` pins that against
 * the server's `parseAdminActionReason`.
 */
export const ADMIN_REASON_PRESETS = {
  creditAdjustment: ['Goodwill credit', 'Refund', 'Support request', 'Abuse / automated signups'],
  suspension: ['Abuse / automated signups', 'Payment fraud', 'Terms violation', 'Customer request'],
  reinstatement: ['Suspended in error', 'Appeal accepted', 'Issue resolved'],
  restriction: ['Abuse / automated signups', 'Suspicious usage', 'Terms violation', 'Under investigation'],
  limitedTier: ['Abuse / automated signups', 'Suspicious usage', 'Under investigation'],
  limitedTierLift: ['Reviewed, not abusive', 'Appeal accepted', 'Applied in error'],
  emailVerification: ['Ownership confirmed by support', 'Bounced or invalid address', 'Internal testing'],
  profileEdit: ['Customer request', 'Correcting a typo', 'Account recovery, identity verified'],
  apiKeyTrust: ['Known integration', 'Partner access', 'Suspicious usage'],
  apiKeyRevokeAll: ['Compromised or leaked keys', 'Abuse / automated signups', 'Customer request'],
  apiKeyRotate: ['Compromised or leaked key', 'Customer request', 'Routine rotation'],
  accountTags: ['Account review', 'Support request', 'Internal testing'],
  productAccess: ['Pilot or partner access', 'Plan change', 'Support request'],
  systemMessage: ['Account notice', 'Support follow-up', 'Policy warning'],
  roleChange: ['Joined the admin team', 'Left the admin team', 'Temporary on-call access'],
  subscriptionGrant: ['Pilot or partner access', 'Billing correction', 'Goodwill grant', 'Internal testing'],
  userDeletion: ['User requested deletion', 'Spam or bot account', 'Terms of service violation', 'Duplicate account'],
  mfaReset: ['Lost authenticator, identity verified', 'New device, identity verified'],
  sessionRevoke: ['Compromised account', 'Lost or stolen device', 'Suspicious sign-in', 'User request'],
  impersonation: ['Reproduce a reported bug', 'Investigate a support ticket', 'Check account configuration'],
  waitlistInvite: [
    'Approved from the waitlist queue',
    'Pilot or partner access',
    'Sales-approved trial',
    'Internal testing',
  ],
  organizationGrant: ['Pilot or partner access', 'Sales-approved trial', 'Internal testing'],
  bulkUserAction: ['Spam or bot account', 'Terms of service violation', 'Billing correction', 'Account cleanup'],
  bulkAbuseResponse: ['Spam or bot cohort', 'Credit farming', 'Disposable email domain', 'Coordinated signup abuse'],
  compChange: ['Pilot or trial ended', 'Granted in error', 'Customer request', 'Account cleanup'],
  creditRateChange: ['Plan change', 'Goodwill adjustment', 'Billing correction', 'Customer request'],
  subscriptionRemove: ['Duplicate record', 'Comp no longer needed', 'Test or internal record', 'Billing correction'],
  seatChange: ['Customer request', 'Team size changed', 'Seats out of sync with billing', 'Billing correction'],
  paidConversion: ['Trial converting to paid', 'Customer request', 'Sales-approved conversion'],
  signupRiskApproval: ['Verified legitimate user', 'Known customer or partner', 'False positive signal'],
} as const satisfies Record<string, readonly string[]>;

export type AdminReasonPresetKey = keyof typeof ADMIN_REASON_PRESETS;

export type AdminReasonDraft = { preset: string | null; note: string };

export const EMPTY_ADMIN_REASON: AdminReasonDraft = { preset: null, note: '' };

export const ADMIN_REASON_HINT = `Pick a reason or write at least ${ADMIN_ACTION_REASON_MIN_LENGTH} characters.`;

const PRESET_SEPARATOR = ': ';

/** The audited reason string: "Preset: note" when both are given, otherwise whichever is set. */
export const composeAdminReason = ({ preset, note }: AdminReasonDraft): string => {
  const trimmedNote = note.trim();
  if (!preset) return trimmedNote;
  return trimmedNote ? `${preset}${PRESET_SEPARATOR}${trimmedNote}` : preset;
};

/** The reason an undo carries: the original one, marked, and still within the shared maximum. */
export const undoAdminReason = (reason: string): string => `Undo: ${reason}`.slice(0, ADMIN_ACTION_REASON_MAX_LENGTH);

export const isAdminReasonComplete = (draft: AdminReasonDraft): boolean =>
  isValidAdminActionReason(composeAdminReason(draft));

/** Longest note that still keeps the composed reason within the shared maximum. */
export const maxAdminReasonNoteLength = (preset: string | null): number =>
  preset ? ADMIN_ACTION_REASON_MAX_LENGTH - preset.length - PRESET_SEPARATOR.length : ADMIN_ACTION_REASON_MAX_LENGTH;
