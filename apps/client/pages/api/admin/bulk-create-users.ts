import { userRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  MAX_STORAGE_LIMIT_MB,
  AuthEvents,
  redactUserSecretsForSelf,
  sanitizeUsername,
  selfUserResponseSchema,
} from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { userService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg, escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { emitSignupFunnelEvents, recordSyntheticIdentity } from '@server/analytics/funnel';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const AUDITED_USER_ID_LIMIT = 100;

const userImportSchema = z.object({
  email: z.email('Invalid email format'),
  first: z.string().optional(),
  last: z.string().optional(),
  startingCredits: z.number().int().min(0, 'Credits must be a positive number').optional(),
  startingStorage: z.number().int().min(0, 'Storage must be a positive number').max(MAX_STORAGE_LIMIT_MB).optional(),
  tags: z.array(z.string()).optional(),
});

interface UserImportRow {
  email: string;
  first?: string;
  last?: string;
  startingCredits?: number;
  startingStorage?: number;
  tags?: string[];
}

const bulkCreateResponseSchema = z.object({
  success: z.literal(true),
  results: z.array(
    z.discriminatedUnion('success', [
      z.object({ success: z.literal(true), email: z.string(), user: selfUserResponseSchema }),
      // Echoes the row as submitted: it failed validation, so its email may be missing or not a string.
      z.object({ success: z.literal(false), email: z.unknown().optional(), error: z.string() }),
    ])
  ),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler<{}, unknown, { users: UserImportRow[] }>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { users } = req.body;

    if (!Array.isArray(users) || users.length === 0) {
      throw new BadRequestError('Invalid input: users array is required and must not be empty');
    }

    const createdUserIds: string[] = [];
    const startingCreditsById = new Map<string, number>();
    const results = await Promise.all(
      users.map(async userData => {
        try {
          const validatedData = userImportSchema.parse(userData);

          // Derived from the address, so coerce it into the username rules rather than reject the row.
          const username = sanitizeUsername(validatedData.email.split('@')[0]) || `user-${randomUUID().slice(0, 8)}`;

          const newUser = await userService.createUser(
            {
              username,
              email: validatedData.email,
              name: `${validatedData.first || ''} ${validatedData.last || ''}`.trim() || validatedData.email,
              initialCredits: validatedData.startingCredits ?? 0,
              record: {
                // Passwordless: no usable password. Store null so `password`
                // presence stays a truthful signal. Users sign in via OTC.
                password: null,
                hasUsablePassword: false,
                storageLimit: validatedData.startingStorage,
              },
            },
            {
              db: {
                users: userRepository,
              },
            }
          );

          createdUserIds.push(newUser.id);
          startingCreditsById.set(newUser.id, validatedData.startingCredits ?? 0);

          const isSynthetic = await recordSyntheticIdentity(newUser);
          await emitSignupFunnelEvents({
            user: { id: newUser.id, isSynthetic },
            method: 'admin',
            emailVerified: newUser.emailVerified === true,
            creditsGranted: newUser.currentCredits ?? validatedData.startingCredits ?? 0,
          });

          if (validatedData.tags && validatedData.tags.length > 0) {
            newUser.tags = validatedData.tags;
          }

          await userRepository.update({ id: newUser.id, tags: newUser.tags });

          const brand = process.env.APP_NAME || '';
          const logoUrl = getLogoUrl();
          const loginLink = `${process.env.APP_URL}/login`;
          const emailBody = `
            <!DOCTYPE html>
            <html>
              <head>
                <style>
                  body {
                    font-family: Arial, sans-serif;
                    line-height: 1.5;
                    color: #333333;
                  }
                  .content {
                    margin: 20px;
                  }
                  .logo {
                    display: block;
                    margin-bottom: 20px;
                  }
                  a {
                    color: #1a82e2;
                  }
                </style>
              </head>
              <body>
                <div class="content">
                  ${buildEmailLogoImg(brand, logoUrl)}
                  <p>Hello ${escapeHtml(newUser.name)},</p>
                  <p>Welcome${brand ? ` to ${brand}` : ''}! Your account has been created.</p>
                  <p>Sign in at the link below — enter your email and we'll send you a one-time sign-in code. No password needed.</p>
                  <p><a href="${loginLink}">${loginLink}</a></p>
                  <p>If you did not request this account, please ignore this email.</p>
                </div>
              </body>
            </html>
          `;

          await EmailEvents.Send.publish({
            to: newUser.email!,
            subject: `Welcome${brand ? ` to ${brand}` : ''} - Sign In`,
            body: emailBody,
          });

          await logEvent(
            {
              userId: req.user.id,
              type: AuthEvents.REGISTER,
              metadata: {},
            },
            { ability: req.ability }
          );

          return {
            success: true,
            email: newUser.email,
            // Passwordless account (no password login); users sign in via OTC.
            user: redactUserSecretsForSelf(newUser),
          };
        } catch (error: any) {
          if (error instanceof z.ZodError) {
            return {
              success: false,
              email: userData.email,
              error: error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
            };
          }
          return { success: false, email: userData.email, error: error.message || 'Unknown error' };
        }
      })
    );

    // Rows commit independently, even when later processing fails. One best-effort entry covers
    // every created account so a failed audit write cannot 500 a created batch.
    if (createdUserIds.length > 0) {
      const auditedIds = createdUserIds.slice(0, AUDITED_USER_ID_LIMIT);
      const startingCreditsTotal = [...startingCreditsById.values()].reduce((sum, credits) => sum + credits, 0);
      try {
        await recordAdminActionFromRequest(req, {
          action: 'user.bulk_created',
          target: { kind: 'system', id: 'bulk-create-users', displayName: 'Bulk user import' },
          summary: `bulk created ${createdUserIds.length} user(s)`,
          details: {
            count: createdUserIds.length,
            failedCount: results.filter(r => !r.success).length,
            createdUserIds: auditedIds,
            credits: startingCreditsTotal,
            startingCreditsTotal,
            startingCreditsByUserId: Object.fromEntries(auditedIds.map(id => [id, startingCreditsById.get(id) ?? 0])),
          },
        });
      } catch (error) {
        req.logger.error('[ADMIN_AUDIT_WRITE_FAILED]', { action: 'user.bulk_created', error });
      }
    }

    // Validates after users are created and invites sent: a bad success row would 500 a batch that
    // succeeded and a retry would hit duplicates, so keep the row schema permissive.
    return respond(res, bulkCreateResponseSchema, {
      success: true,
      results,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
