import { IBaseEvent } from '../../../types';

/**
 * The forced MFA enrollment funnel (admin setting enforceMFA, user with no factor). All four are
 * recorded by the server only: required at the sign-in or registration that owes enrollment,
 * shown when the enrollment screen fetches its secret (once per load, so count distinct users),
 * abandoned when the user leaves the screen without enrolling, completed when the factor is
 * confirmed. Voluntary enrollment from the profile records none of them.
 */
export enum MfaEnrollmentEvents {
  REQUIRED = 'mfa_enrollment_required',
  SHOWN = 'mfa_enrollment_shown',
  ABANDONED = 'mfa_enrollment_abandoned',
  COMPLETED = 'mfa_enrollment_completed',
}

/**
 * `surface`: `signin` is the sign-in modal under a pending (pre-second-factor) token; `session` is
 * the full-screen enforcement screen over a session that already exists (a new registration, or a
 * session minted before enforcement applied). `source` is how the sign-in or session started
 * (its createdVia), when known.
 */
export interface MfaEnrollmentEventPayload extends IBaseEvent {
  type: MfaEnrollmentEvents;
  metadata?: { surface?: 'signin' | 'session'; source?: string; strategy?: string };
}
