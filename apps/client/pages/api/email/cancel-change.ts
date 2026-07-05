import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { userService } from '@bike4mind/services';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';

// Authenticated endpoint for users to cancel their pending email change
const handler = baseApi({ auth: true })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      await withTransaction(async () => {
        // Get user to capture pending email before cancellation
        const user = await userRepository.findById(req.user!.id);
        const pendingEmail = user?.pendingEmail;

        await userService.cancelEmailChange(
          { userId: req.user!.id },
          {
            db: {
              users: userRepository,
            },
          }
        );

        // Log email change cancellation
        await logAuditEvent(
          {
            userId: req.user!.id,
            action: EmailAuditEvents.EMAIL_CHANGE_CANCELLED,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            newEmail: pendingEmail || undefined,
          },
          req.logger
        );

        req.logger.info(`User ${req.user!.id} cancelled pending email change`);

        return res.json({ message: 'Email change cancelled successfully' });
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
