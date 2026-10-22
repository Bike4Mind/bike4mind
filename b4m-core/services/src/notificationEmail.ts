/** Shared helpers for notification emails. */

/**
 * Minimal HTML escaper for values interpolated into notification email bodies (user-supplied
 * strings such as lake or key names). Local rather than reusing the app-layer escaper
 * (viewerSecurity.ts) - this module lives in b4m-core/services, which cannot import apps/client code.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shared shell for a notification email: a div wrapping the body plus a small grey footer line. */
export function wrapEmail(bodyHtml: string, footerText: string): string {
  return `<div>${bodyHtml}<p style="color:#666;font-size:12px">${footerText}</p></div>`;
}
