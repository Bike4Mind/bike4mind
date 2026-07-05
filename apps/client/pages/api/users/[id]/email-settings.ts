import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { User } from '@bike4mind/database';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';

// Inbound-email recipient domain, externalized for open-core: no brand fallback.
// When PLATFORM_EMAIL_DOMAIN is unset the suffix check is skipped (any valid email is
// accepted) rather than enforcing a brand domain that no longer exists.
const PLATFORM_EMAIL_DOMAIN = process.env.PLATFORM_EMAIL_DOMAIN || '';
// Anchor the suffix on the "@" boundary so a domain configured without a leading "@"
// (e.g. "app.acme.com") can't accept a different domain like "x@evilapp.acme.com". Empty when
// unconfigured -> the refine below is skipped.
const PLATFORM_EMAIL_SUFFIX = PLATFORM_EMAIL_DOMAIN
  ? PLATFORM_EMAIL_DOMAIN.startsWith('@')
    ? PLATFORM_EMAIL_DOMAIN
    : `@${PLATFORM_EMAIL_DOMAIN}`
  : '';

const EmailSettingsSchema = z.object({
  platformEmailAddress: z
    .email()
    .toLowerCase()
    .refine(email => !PLATFORM_EMAIL_SUFFIX || email.endsWith(PLATFORM_EMAIL_SUFFIX), {
      error: `Platform email must end with ${PLATFORM_EMAIL_SUFFIX}`,
    })
    .optional(),
  authorizedEmailAddresses: z.array(z.email().toLowerCase()).optional(),
});

const handler = baseApi()
  .patch(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id;
      const requestingUserId = req.user?.id;

      // Users can only update their own settings (or admins can update any)
      if (userId !== requestingUserId && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Not authorized to update these settings' });
      }

      try {
        const emailSettings = EmailSettingsSchema.parse(req.body);

        // If platform email is being set, check if it's already taken
        if (emailSettings.platformEmailAddress) {
          const existingUser = await User.findOne({
            platformEmailAddress: emailSettings.platformEmailAddress,
            _id: { $ne: userId },
          });

          if (existingUser) {
            return res.status(409).json({
              error: 'This platform email address is already in use by another user',
            });
          }
        }

        // Update user's email settings
        const updateFields: any = {};
        if (emailSettings.platformEmailAddress !== undefined) {
          updateFields.platformEmailAddress = emailSettings.platformEmailAddress;
        }
        if (emailSettings.authorizedEmailAddresses !== undefined) {
          updateFields.authorizedEmailAddresses = emailSettings.authorizedEmailAddresses;
        }

        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { $set: updateFields },
          { new: true, runValidators: true }
        ).select('platformEmailAddress authorizedEmailAddresses');

        if (!updatedUser) {
          return res.status(404).json({ error: 'User not found' });
        }

        Logger.info(`Updated email settings for user ${userId}`, {
          platformEmailAddress: updatedUser.platformEmailAddress,
          authorizedEmailCount: updatedUser.authorizedEmailAddresses?.length || 0,
        });

        return res.json({
          message: 'Email settings updated successfully',
          platformEmailAddress: updatedUser.platformEmailAddress,
          authorizedEmailAddresses: updatedUser.authorizedEmailAddresses,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({
            error: 'Invalid settings data',
            details: error.issues,
          });
        }

        Logger.error('Error updating email settings:', error);
        return res.status(500).json({ error: 'Failed to update settings' });
      }
    })
  )
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id;
      const requestingUserId = req.user?.id;

      // Users can only view their own settings (or admins can view any)
      if (userId !== requestingUserId && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Not authorized to view these settings' });
      }

      try {
        const user = await User.findById(userId).select('platformEmailAddress authorizedEmailAddresses');
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        return res.json({
          platformEmailAddress: user.platformEmailAddress || null,
          authorizedEmailAddresses: user.authorizedEmailAddresses || [],
        });
      } catch (error) {
        Logger.error('Error fetching email settings:', error);
        return res.status(500).json({ error: 'Failed to fetch settings' });
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
