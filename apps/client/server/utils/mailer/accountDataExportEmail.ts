import { buildEmailLogoImg, escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';

export interface AccountDataExportReadyEmailInput {
  /** The app page that issues a fresh download link: `${APP_URL}/account-data-export/<jobId>`. */
  downloadPageUrl: string;
  expiresAt: Date;
}

export interface EmailContent {
  subject: string;
  body: string;
}

const formatDateTime = (date: Date): string =>
  date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });

const toSubject = (text: string): string => text.replace(/[\r\n]+/g, ' ');

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
          .header {
            border-bottom: 3px solid #1976d2;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .logo {
            max-height: 40px;
            margin-bottom: 12px;
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
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666666;
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
        <div class="footer">
          <p>You are receiving this because a copy of your account data was requested${brand ? ` on ${escapeHtml(brand)}` : ''}. If this was not you, change your password and sign out of your other devices.</p>
        </div>
      </body>
    </html>
  `;

export const buildAccountDataExportReadyEmail = (input: AccountDataExportReadyEmailInput): EmailContent => {
  const brand = process.env.APP_NAME || '';
  const content = `
          <p>Hello,</p>
          <p>The copy of your account data you asked for is ready to download.</p>
          <div style="text-align: center;">
            <a href="${escapeHtml(input.downloadPageUrl)}" class="cta-button">Download your data</a>
          </div>
          <p>You will need to sign in to download it. The link works until <strong>${formatDateTime(input.expiresAt)}</strong>; after that, request a new export from your account settings.</p>
  `;

  return {
    subject: toSubject(`Your ${brand ? `${brand} ` : ''}data export is ready`),
    body: layout(brand, 'Your data export is ready', content),
  };
};
