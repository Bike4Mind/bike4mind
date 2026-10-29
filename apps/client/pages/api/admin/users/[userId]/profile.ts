import { z } from 'zod';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HTTPError,
  NotFoundError,
  type AuditChange,
} from '@bike4mind/common';
import { userRepository, withTransaction } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireStepUp } from '@server/auth/stepUp';
import {
  buildEmailChangeMailer,
  publishEmailChangeMessages,
  type EmailChangeMessage,
} from '@server/users/emailChangeMailer';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

export type AdminProfileField = 'name' | 'username' | 'email';

const bodySchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(200, 'Names can be up to 200 characters.').optional(),
  username: z.string().optional(),
  // Same normalization as the self-service change route, so both compare addresses alike.
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')).optional(),
});

/** Tags a validation or uniqueness error with the field it belongs to, for the dialog's inline error. */
const onField = async <T>(field: AdminProfileField, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HTTPError) error.additionalInfo = { ...error.additionalInfo, field };
    throw error;
  }
};

/**
 * Admin edit of a user's name, username and email, with a required, audited reason. The email is
 * never written directly: it starts the same verification flow as a self-service change, so the
 * address only switches once the new owner clicks the link. Errors carry `field` when they belong to one.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .patch(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

      const { userId } = req.query as { userId?: unknown };
      if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BadRequestError(issue.message, { field: issue.path[0] });
      }
      const reason = parseAdminActionReason((req.body as { reason?: unknown }).reason);
      const { name, email } = parsed.data;

      const outbox: EmailChangeMessage[] = [];
      const result = await withTransaction(async () => {
        const user = await userRepository.findById(userId);
        if (!user) throw new NotFoundError('User not found');

        const params = { username: parsed.data.username };
        await onField('username', () =>
          userService.validateUsernameChange(user, params, userRepository, { allowReservedUsername: true })
        );

        const changes: AuditChange[] = [];
        if (name !== undefined && name !== (user.name ?? '')) {
          changes.push({ field: 'name', before: user.name ?? null, after: name });
        }
        if (params.username !== undefined && params.username !== user.username) {
          changes.push({ field: 'username', before: user.username, after: params.username });
        }
        const changesEmail = email !== undefined && email !== user.email?.trim().toLowerCase();
        if (changes.length === 0 && !changesEmail) throw new BadRequestError('Change the name, username or email.');

        if (changesEmail) {
          // Whoever confirms the new address can sign in as this user, so this is held to the same
          // bar as any credential change: a recently re-verified session.
          await requireStepUp(req);
          if (await userRepository.existsOtherUserWithEmail(email, user.id)) {
            throw new ConflictError(userService.EMAIL_IN_USE_MESSAGE, { field: 'email' });
          }
        }

        if (changes.length > 0) {
          await onField('username', () =>
            userService.writeUserUpdate(userRepository, {
              id: user.id,
              ...Object.fromEntries(changes.map(change => [change.field, change.after])),
            })
          );
        }
        if (changesEmail) {
          await userService.requestEmailChange(
            { userId: user.id, newEmail: email },
            { db: { users: userRepository }, mailer: buildEmailChangeMailer(outbox, { byAdmin: true }) }
          );
          changes.push({ field: 'pendingEmail', before: user.pendingEmail ?? null, after: email });
        }

        await recordAdminActionFromRequest(req, {
          action: 'user.identity.updated',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: `updated ${changes.map(change => change.field).join(', ')}`,
          reason,
          changes,
          details: changesEmail ? { currentEmail: user.email ?? null } : undefined,
        });

        return {
          name: name ?? user.name,
          username: params.username ?? user.username,
          email: user.email,
          pendingEmail: changesEmail ? email : (user.pendingEmail ?? null),
        };
      });

      await publishEmailChangeMessages(outbox, req.logger, userId);
      return res.json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
