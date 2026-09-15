import { emailTemplateRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import mailer from '@server/utils/mailer';

const handler = baseApi({ auth: true }).post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

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
    htmlContent = htmlContent.replace(regex, value);
    subject = subject.replace(regex, value);
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

    return res.json({
      success: true,
      message: `Test email sent to ${email}`,
      subject,
    });
  } catch (error: any) {
    throw new BadRequestError(`Failed to send test email: ${error.message}`);
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
