// Recipients are trimmed and validated before the notebook email is sent, so the
// request carries no padding, blank rows or malformed entries. Kept pure and
// separate from the modal so this normalisation is unit-testable on its own.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeRecipients = (recipients: string[]): string[] =>
  recipients.map(email => email.trim()).filter(email => EMAIL_PATTERN.test(email));
