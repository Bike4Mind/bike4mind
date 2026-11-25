import { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { sendLiveTestEmail } from '@bike4mind/server-utils/utils/mailer/testEmail';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { z } from 'zod';

const TestEmailSchema = z.object({
  to: z.email().optional(),
});

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 1000, // 5 attempts per minute
    })
  )
  .post(async (req: Request, res: Response) => {
    try {
      const { to } = TestEmailSchema.parse(req.body);

      // Use provided email or fall back to admin's email
      const recipientEmail = to || req.user.email;

      if (!recipientEmail) {
        throw new BadRequestError('No email address provided and user has no email on file.');
      }

      const result = await sendLiveTestEmail(recipientEmail);

      await recordAdminActionFromRequest(req, {
        action: 'system_health.test_run',
        target: { kind: 'system', id: 'system-health', displayName: 'System health' },
        summary: 'sent a test email',
        details: { testType: 'email' },
      });

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
      if (error instanceof BadRequestError) {
        return res.status(400).json({ success: false, error: error.message });
      }

      req.logger.error('Error sending test email', { error });
      return res.status(500).json({
        success: false,
        // A rejected Lambda invoke carries raw AWS SDK text, so it stays in the log above.
        error: 'Failed to send test email',
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
