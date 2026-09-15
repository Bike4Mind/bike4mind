import { emailJobRepository, emailTemplateRepository, userRepository, subscriberRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';

/**
 * GET /api/admin/email/jobs/:id/preview-for-user?userId=xxx&type=user|subscriber
 *
 * Renders the email as it would appear for a specific user/subscriber.
 * Used for preview dropdown in campaign editor.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id, userId, type = 'user' } = req.query as { id: string; userId?: string; type?: 'user' | 'subscriber' };

  if (!userId) {
    throw new BadRequestError('userId is required');
  }

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  const template = await emailTemplateRepository.findById(job.templateId);
  if (!template) {
    throw new NotFoundError('Template not found');
  }

  // Get user/subscriber data for variable substitution
  let recipientData: {
    id: string;
    email: string;
    name?: string;
    firstName?: string;
  };

  if (type === 'subscriber') {
    const subscriber = await subscriberRepository.findById(userId);
    if (!subscriber) {
      throw new NotFoundError('Subscriber not found');
    }
    recipientData = {
      id: subscriber.id,
      email: subscriber.email,
      name: subscriber.email.split('@')[0],
      firstName: subscriber.email.split('@')[0],
    };
  } else {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    recipientData = {
      id: user.id,
      email: user.email || '',
      name: user.name,
      firstName: user.name?.split(' ')[0],
    };
  }

  // Build variable map
  const variables: Record<string, string> = {
    // User-specific variables
    userName: recipientData.name || recipientData.email.split('@')[0],
    userFirstName: recipientData.firstName || recipientData.name?.split(' ')[0] || recipientData.email.split('@')[0],
    userEmail: recipientData.email,
    // App variables
    appName: process.env.APP_NAME || '',
    date: new Date().toLocaleDateString(),
    // Placeholder URLs (will be replaced with real tracking URLs when sent)
    unsubscribeUrl: '#unsubscribe',
    preferencesUrl: '#preferences',
    // Job-level variable overrides
    ...Object.fromEntries(job.variables instanceof Map ? job.variables : Object.entries(job.variables || {})),
  };

  // Render subject
  let renderedSubject = job.subject || template.subject;
  for (const [key, value] of Object.entries(variables)) {
    renderedSubject = renderedSubject.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  // Render HTML content
  let renderedHtml = template.htmlContent;
  for (const [key, value] of Object.entries(variables)) {
    renderedHtml = renderedHtml.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }

  return res.json({
    subject: renderedSubject,
    html: renderedHtml,
    recipient: {
      id: recipientData.id,
      email: recipientData.email,
      name: recipientData.name,
      type,
    },
    variables,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
