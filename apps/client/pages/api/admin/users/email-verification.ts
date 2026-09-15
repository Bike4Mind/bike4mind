import { asyncHandler } from '@server/middlewares/asyncHandler';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

const EmailVerificationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).prefault(1),
  limit: z.coerce.number().int().min(1).max(100).prefault(20),
  status: z.enum(['all', 'verified', 'unverified', 'pending']).prefault('all'),
  search: z.string().optional(),
});

// Admin-only endpoint to list users by email verification status
const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    // Check admin authorization
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { page, limit, status, search } = EmailVerificationQuerySchema.parse(req.query);
    const skip = (page - 1) * limit;

    // Build filter based on status. Exclude system accounts from admin user listings.
    const filter: any = { isSystem: { $ne: true } };

    if (status === 'verified') {
      filter.emailVerified = true;
    } else if (status === 'unverified') {
      filter.emailVerified = false;
      filter.emailVerificationToken = null; // Not currently pending
    } else if (status === 'pending') {
      filter.emailVerified = false;
      filter.emailVerificationToken = { $ne: null }; // Has active token
    }
    // 'all' status has no additional filter

    // Add search filter if provided
    if (search) {
      const escapedSearch = escapeRegex(search);
      filter.$or = [
        { username: { $regex: escapedSearch, $options: 'i' } },
        { email: { $regex: escapedSearch, $options: 'i' } },
        { name: { $regex: escapedSearch, $options: 'i' } },
      ];
    }

    // Get users with verification info
    const users = await User.find(filter)
      .select(
        'username email name emailVerified emailVerifiedAt emailVerificationSentAt emailVerificationExpires pendingEmail pendingEmailToken pendingEmailSentAt pendingEmailExpires createdAt'
      )
      .sort({ emailVerificationSentAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const totalCount = await User.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / limit);

    return res.json({
      users,
      pagination: {
        page,
        limit,
        totalPages,
        totalCount,
      },
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
