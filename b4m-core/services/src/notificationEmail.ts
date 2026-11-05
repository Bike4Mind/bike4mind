/** Shared helpers for notification emails. */

// Re-exported so the email builders in this package keep a single import.
export { escapeHtml } from '@bike4mind/utils/escapeHtml';

/** Shared shell for a notification email: a div wrapping the body plus a small grey footer line. */
export function wrapEmail(bodyHtml: string, footerText: string): string {
  return `<div>${bodyHtml}<p style="color:#666;font-size:12px">${footerText}</p></div>`;
}
