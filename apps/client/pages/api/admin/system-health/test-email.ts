import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { MailService, type TestEmailResult } from '@server/utils/mailer';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { z } from 'zod';

const TestEmailSchema = z.object({
  to: z.email().optional(),
});

const handler = baseApi()
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000, // 5 attempts per minute
    })
  )
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const { to } = TestEmailSchema.parse(req.body);

      // Use provided email or fall back to admin's email
      const recipientEmail = to || req.user.email;

      if (!recipientEmail) {
        throw new BadRequestError('No email address provided and user has no email on file.');
      }

      const mailService = new MailService();
      const result: TestEmailResult = await mailService.sendTestEmail(recipientEmail);

      await logAuditEvent(
        {
          userId: req.user!.id,
          action: AdminConfigAuditEvents.ADMIN_TEST_EMAIL_SENT,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
        },
        req.logger
      );

      return res.json({
        ...result,
        sentTo: recipientEmail,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email address format',
        });
      }

      console.error('Error sending test email:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send test email',
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
