import { escapeHtml } from './renderSpendNotificationEmail';

/**
 * Which party this email goes to, and why. The offer goes to the RECIPIENT (who must act); the
 * outcome goes to the OFFERER (who is waiting). There is no email on cancel - the offerer is the one
 * doing it, and the recipient learns the offer is gone from its absence.
 */
export type OwnershipOfferEmailKind = 'offered' | 'accepted' | 'declined';

export interface OwnershipOfferEmailInput {
  kind: OwnershipOfferEmailKind;
  lakeName: string;
  /**
   * Display name of the OTHER party: the offerer on `offered`, the recipient on `accepted` /
   * `declined`. Absent when the user record carries neither name nor username, in which case the
   * copy falls back to a role word rather than an empty slot.
   */
  counterpartName?: string;
  /** The offer's expiry, named in the `offered` copy so the recipient knows the clock. */
  expiresAt?: Date;
}

export interface OwnershipOfferEmailContent {
  subject: string;
  html: string;
}

const FOOTER =
  '<p style="color:#666;font-size:12px">You are receiving this because you are party to a data lake ownership offer.</p>';

function wrap(lakeNameEscaped: string, bodyHtml: string): string {
  return `<div><p><strong>${lakeNameEscaped}</strong></p>${bodyHtml}${FOOTER}</div>`;
}

/**
 * Render the subject/body for one lake ownership offer email. Pure - no I/O, no db/mailer access -
 * so each kind is unit-testable in isolation. Carries only the lake name and a display name: no
 * files, no `systemPrompt`, no member roster (the same disclosure rule the recipient's in-app offer
 * list follows).
 */
export function renderOwnershipOfferEmail(input: OwnershipOfferEmailInput): OwnershipOfferEmailContent {
  const { kind } = input;
  const lake = escapeHtml(input.lakeName);
  // Subject headers are not HTML, but a lake name is free-text with no newline restriction - strip
  // CR/LF locally rather than trust the transport to sanitize header injection.
  const subjectName = input.lakeName.replace(/[\r\n]+/g, ' ');
  const who = input.counterpartName ? escapeHtml(input.counterpartName) : undefined;
  const expiresAt = input.expiresAt ? input.expiresAt.toISOString().slice(0, 10) : undefined;

  if (kind === 'offered') {
    return {
      subject: `You have been offered ownership of "${subjectName}"`,
      html: wrap(
        lake,
        `<p>${who ?? 'A teammate'} has offered you ownership of this data lake.</p>` +
          `<p>Nothing changes until you accept. Open the Data Lakes manager to accept or decline` +
          `${expiresAt ? `; the offer expires on ${expiresAt}` : ''}.</p>`
      ),
    };
  }

  if (kind === 'accepted') {
    return {
      subject: `Ownership of "${subjectName}" was accepted`,
      html: wrap(
        lake,
        `<p>${who ?? 'The member you chose'} accepted ownership of this data lake.</p>` +
          `<p>You stay on as a curator, so you can still manage it - but only the new owner can transfer it ` +
          `again or change how it is shared.</p>`
      ),
    };
  }

  if (kind === 'declined') {
    return {
      subject: `Ownership offer for "${subjectName}" was declined`,
      html: wrap(
        lake,
        `<p>${who ?? 'The member you chose'} declined ownership of this data lake.</p>` +
          `<p>Ownership is unchanged and the offer is closed; you can offer it to someone else.</p>`
      ),
    };
  }

  // Every kind is handled above; reaching here means one was added without updating this renderer,
  // which would otherwise silently fall through to whichever branch happened to be last.
  throw new Error(`renderOwnershipOfferEmail: unhandled kind "${kind}"`);
}
