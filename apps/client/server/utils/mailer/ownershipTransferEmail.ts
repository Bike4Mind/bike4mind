import type { Logger } from '@bike4mind/observability';
import { buildEmailLogoImg, escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';

export interface OwnershipTransferParty {
  email: string | null | undefined;
  name: string | null | undefined;
}

export interface OwnershipTransferEmailInput {
  organizationName: string;
  /** Link to the organization page; the new owner lands on Billing from there. */
  organizationUrl: string;
  previousOwner: OwnershipTransferParty;
  newOwner: OwnershipTransferParty;
}

export interface EmailContent {
  subject: string;
  body: string;
}

// A subject is plain text, not HTML; line breaks are dropped so an org name cannot spill into
// further header lines (same rule as inviteNotificationEmail.ts).
const toSubject = (text: string): string => text.replace(/[\r\n]+/g, ' ');

const displayName = (party: OwnershipTransferParty): string => party.name?.trim() || party.email?.trim() || 'a member';

const layout = (brand: string, heading: string, content: string): string => `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header { border-bottom: 3px solid #1976d2; padding-bottom: 20px; margin-bottom: 30px; }
          .logo { max-height: 40px; margin-bottom: 12px; }
          h1 { color: #1976d2; font-size: 24px; margin: 0; }
          .cta-button {
            display: inline-block;
            background-color: #1976d2;
            color: white !important;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          ${buildEmailLogoImg(brand)}
          <h1>${heading}</h1>
        </div>
        <div class="content">
          ${content}
        </div>
      </body>
    </html>
  `;

/** To the new owner: they now hold billing for the team. */
export const buildNewOwnerEmail = (input: OwnershipTransferEmailInput): EmailContent => {
  const brand = process.env.APP_NAME || '';
  const team = escapeHtml(input.organizationName);
  const content = `
          <p>Hello,</p>
          <p>${escapeHtml(displayName(input.previousOwner))} transferred ownership of <strong>${team}</strong> to you.</p>
          <p>You are now the team's billing owner: the subscription, payment method and invoices are yours to manage, and only you can delete the team or transfer it again.</p>
          <div style="text-align: center;">
            <a href="${escapeHtml(input.organizationUrl)}" class="cta-button">Open ${team}</a>
          </div>
  `;
  return {
    subject: toSubject(`You are now the owner of ${input.organizationName}`),
    body: layout(brand, 'You now own this team', content),
  };
};

/** To the former owner: confirmation, and what they can still do. */
export const buildPreviousOwnerEmail = (input: OwnershipTransferEmailInput): EmailContent => {
  const brand = process.env.APP_NAME || '';
  const team = escapeHtml(input.organizationName);
  const content = `
          <p>Hello,</p>
          <p>Ownership of <strong>${team}</strong> was transferred to ${escapeHtml(displayName(input.newOwner))}. They are now the team's billing owner.</p>
          <p>You stay on the team as a member, and you can now leave it from the Members tab.</p>
          <div style="text-align: center;">
            <a href="${escapeHtml(input.organizationUrl)}" class="cta-button">Open ${team}</a>
          </div>
  `;
  return {
    subject: toSubject(`Ownership of ${input.organizationName} was transferred`),
    body: layout(brand, 'Team ownership transferred', content),
  };
};

/**
 * Tell both parties about a committed transfer. Best-effort and never throws: the transfer has
 * already happened, and a lost email must not turn it into a failed request.
 */
export async function sendOwnershipTransferEmails(input: OwnershipTransferEmailInput, logger: Logger): Promise<void> {
  const messages: Array<EmailContent & { to: string }> = [];
  if (input.newOwner.email) messages.push({ to: input.newOwner.email, ...buildNewOwnerEmail(input) });
  if (input.previousOwner.email) messages.push({ to: input.previousOwner.email, ...buildPreviousOwnerEmail(input) });

  const results = await Promise.allSettled(messages.map(message => EmailEvents.Send.publish(message)));
  results.forEach(result => {
    if (result.status === 'rejected') {
      logger.warn('Could not send an ownership transfer email', {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}
