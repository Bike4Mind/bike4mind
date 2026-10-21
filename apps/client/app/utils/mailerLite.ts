const SCRIPT_ID = 'mailerlite';
const SCRIPT_URL = '/scripts/ml.js';

/** Injects the MailerLite loader. Call ONLY once the visitor has granted cookie consent.
 * Idempotent. */
export function loadMailerLite(): void {
  if (typeof window === 'undefined') return;
  if (document.getElementById(SCRIPT_ID)) return;
  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = SCRIPT_URL;
  document.head.appendChild(script);
}
