import { escapeHtml } from './emailHelpers';

export interface OrgAlertEmailInput {
  organizationName: string;
  heading: string;
  /** Plain text; escaped here. */
  message: string;
  settingsUrl?: string;
}

/** Subjects are plain text; line breaks are dropped so an org name cannot spill into more header lines. */
export const toOrgAlertSubject = (text: string): string => text.replace(/[\r\n]+/g, ' ');

export function buildOrgAlertEmailBody({
  organizationName,
  heading,
  message,
  settingsUrl,
}: OrgAlertEmailInput): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h1 style="color: #1976d2; font-size: 20px;">${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>You are receiving this because you manage ${escapeHtml(organizationName)} and have this alert turned on.</p>
    ${settingsUrl ? `<p><a href="${escapeHtml(settingsUrl)}">Review alert settings</a></p>` : ''}
  </body>
</html>`;
}
