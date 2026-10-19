import { InviteType } from '@bike4mind/common';
import { EmailEvents } from '@server/utils/eventBus';
import { escapeHtml } from './emailHelpers';

/** Human-readable noun for an invite type, as used in invite email copy. */
export const getInviteTypeName = (type: InviteType): string => {
  switch (type) {
    case InviteType.FabFile:
      return 'file';
    case InviteType.Session:
      return 'notebook';
    case InviteType.Project:
      return 'project';
    case InviteType.Organization:
      return 'organization';
    case InviteType.Group:
      return 'group';
    default:
      return 'content';
  }
};

/**
 * Emails each pending recipient a link to the invite. Shared by the generic invite route
 * (pages/api/[type]/[id]/invites) and the project-specific one (pages/api/projects/[id]/invites),
 * which shadows the generic route for projects.
 */
export const sendInviteNotificationEmails = async (
  recipients: string[],
  sharerName: string,
  sharerEmail: string,
  documentName: string,
  typeName: string,
  inviteLink: string,
  description?: string
) => {
  const brand = process.env.APP_NAME || '';
  const emailBody = `
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
          .header {
            border-bottom: 3px solid #1976d2;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .content {
            margin: 20px 0;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
          }
          h1 {
            color: #1976d2;
            font-size: 24px;
            margin: 0;
          }
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
          .description {
            background-color: #f5f5f5;
            padding: 15px;
            border-radius: 8px;
            border-left: 4px solid #1976d2;
            margin: 20px 0;
            font-style: italic;
          }
          .shared-item {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>You've Been Invited!</h1>
        </div>

        <div class="content">
          <p>Hello!</p>

          <p><strong>${escapeHtml(sharerName)}</strong> (${escapeHtml(sharerEmail)}) has shared a ${typeName} with you${brand ? ` on ${brand}` : ''}.</p>

          <div class="shared-item">
            <strong>${typeName.charAt(0).toUpperCase() + typeName.slice(1)}:</strong> ${escapeHtml(documentName)}
          </div>

          ${
            description
              ? `
          <div class="description">
            <strong>Message:</strong><br/>
            ${escapeHtml(description).replace(/\n/g, '<br/>')}
          </div>
          `
              : ''
          }

          <div style="text-align: center;">
            <a href="${inviteLink}" class="cta-button">Accept Invitation</a>
          </div>

          <p style="margin-top: 30px; font-size: 14px; color: #666;">
            Click the button above to view and accept this invitation. If you don't have a${brand ? ` ${brand}` : 'n'} account yet, you'll be prompted to create one.
          </p>
        </div>

        <div class="footer">
          <p>This email was sent${brand ? ` from ${brand}, an AI collaboration platform` : ''}.</p>
          <p>If you have questions about this invitation, please contact ${escapeHtml(sharerName)} at ${escapeHtml(sharerEmail)}.</p>
        </div>
      </body>
    </html>
  `;

  // A subject is plain text, so it is not HTML-escaped; line breaks are dropped so the name
  // cannot spill into further header lines.
  const emailPromises = recipients.map(recipient =>
    EmailEvents.Send.publish({
      to: recipient,
      subject: `${sharerName.replace(/[\r\n]+/g, ' ')} shared a ${typeName} with you${brand ? ` on ${brand}` : ''}`,
      body: emailBody,
    }).catch(error => {
      console.error(`Failed to send invite notification to ${recipient}:`, error);
    })
  );

  await Promise.allSettled(emailPromises);
};
