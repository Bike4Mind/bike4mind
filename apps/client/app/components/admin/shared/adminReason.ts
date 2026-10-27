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
  creditAdjustment: [
    'Goodwill credit',
    'Refund for a failed request',
    'Billing correction',
    'Promotional grant',
    'Abuse or bot cleanup',
  ],
  roleChange: ['Joined the admin team', 'Left the admin team', 'Temporary on-call access'],
  subscriptionGrant: ['Pilot or partner access', 'Billing correction', 'Goodwill grant', 'Internal testing'],
  userDeletion: ['User requested deletion', 'Spam or bot account', 'Terms of service violation', 'Duplicate account'],
  mfaReset: ['Lost authenticator, identity verified', 'New device, identity verified'],
  impersonation: ['Reproduce a reported bug', 'Investigate a support ticket', 'Check account configuration'],
  organizationGrant: ['Pilot or partner access', 'Sales-approved trial', 'Internal testing'],
  bulkAbuseResponse: ['Spam or bot cohort', 'Credit farming', 'Disposable email domain', 'Coordinated signup abuse'],
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

export const isAdminReasonComplete = (draft: AdminReasonDraft): boolean =>
  isValidAdminActionReason(composeAdminReason(draft));

/** Longest note that still keeps the composed reason within the shared maximum. */
export const maxAdminReasonNoteLength = (preset: string | null): number =>
  preset ? ADMIN_ACTION_REASON_MAX_LENGTH - preset.length - PRESET_SEPARATOR.length : ADMIN_ACTION_REASON_MAX_LENGTH;
