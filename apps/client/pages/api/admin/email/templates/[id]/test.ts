import { emailTemplateRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import mailer from '@server/utils/mailer';
import { escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { ApiKeyScope } from '@bike4mind/common';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  auth: true,
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const { id } = req.query as { id: string };
  const { email } = req.body as { email: string };

  if (!email) {
    throw new BadRequestError('Email address is required');
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new BadRequestError('Invalid email address format');
  }

  const template = await emailTemplateRepository.findById(id);
  if (!template) {
    throw new NotFoundError('Template not found');
  }

  // Render template with test data
  let htmlContent = template.htmlContent;
  let subject = template.subject;

  const testData: Record<string, string> = {
    userName: 'Test User',
    userFirstName: 'Test',
    userEmail: email,
    appName: process.env.APP_NAME || '',
    date: new Date().toLocaleDateString(),
    unsubscribeUrl: '#unsubscribe-test',
  };

  // Replace variables
  Object.entries(testData).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    // Function replacers so a `$` in a value is not read as a replacement pattern.
    htmlContent = htmlContent.replace(regex, () => escapeHtml(value));
    subject = subject.replace(regex, () => value);
  });

  // Add test indicator to subject
  subject = `[TEST] ${subject}`;

  try {
    const result = await mailer.sendEmail(email, {
      subject,
      html: htmlContent,
      text: template.textContent || undefined,
    });

    if (result === false) {
      throw new Error('Email service returned failure');
    }
  } catch (error: any) {
    throw new BadRequestError(`Failed to send test email: ${error.message}`);
  }

  await recordAdminActionFromRequest(req, {
    action: 'email.template.test_sent',
    target: { kind: 'settings', id, displayName: template.name },
    summary: `sent test of email template ${template.name}`,
    details: { recipientCount: 1 },
  });

  return res.json({
    success: true,
    message: `Test email sent to ${email}`,
    subject,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
