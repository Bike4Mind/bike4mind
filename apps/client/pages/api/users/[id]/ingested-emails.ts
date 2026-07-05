import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { IngestedEmailModel } from '@bike4mind/database';
import mongoose from 'mongoose';

/**
 * GET /api/users/[id]/ingested-emails
 * Fetch ingested emails for a user
 *
 * Query params:
 * - limit: number of emails to fetch (default: 50, max: 100)
 * - offset: pagination offset (default: 0)
 */
const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string; limit?: string; offset?: string }>(async (req, res) => {
      console.log('📧 GET /api/users/[id]/ingested-emails called');
      const userId = req.query.id;
      const requestingUserId = req.user?.id;
      console.log('🔍 Request details:', {
        userId,
        requestingUserId,
        isAdmin: req.user?.isAdmin,
        query: req.query,
      });

      // Authorization: user can only fetch their own emails
      if (userId !== requestingUserId && !req.user?.isAdmin) {
        console.log('❌ Forbidden: User trying to access other user emails');
        return res.status(403).json({ error: 'Forbidden: You can only view your own emails' });
      }

      const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
      const offset = parseInt(req.query.offset || '0', 10);
      console.log('📄 Pagination:', { limit, offset });

      console.log('🔍 Querying MongoDB for emails...');
      const emails = await IngestedEmailModel.find({ userId })
        .sort({ receivedAt: -1 }) // Most recent first
        .skip(offset)
        .limit(limit)
        .lean()
        .exec();
      console.log('✅ Found emails:', emails.length);

      const total = await IngestedEmailModel.countDocuments({ userId });
      console.log('📊 Total emails in DB for user:', total);

      const response = {
        emails,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + emails.length < total,
        },
      };
      console.log('📤 Returning response:', {
        emailCount: emails.length,
        pagination: response.pagination,
      });

      return res.json(response);
    })
  )
  .delete(
    asyncHandler<{}, unknown, { emailIds?: string[] }, { id?: string }>(async (req, res) => {
      const userId = req.query.id;
      const requestingUserId = req.user?.id;

      // Authorization: user can only delete their own emails
      if (userId !== requestingUserId && !req.user?.isAdmin) {
        return res.status(403).json({ error: 'Forbidden: You can only delete your own emails' });
      }

      const { emailIds } = req.body;
      if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
        return res.status(400).json({ error: 'emailIds array is required' });
      }

      if (emailIds.length > 100) {
        return res.status(400).json({ error: 'Maximum 100 emails per delete request' });
      }

      // Reject malformed IDs up front - new mongoose.Types.ObjectId(badString) throws,
      // which would turn a client error into an opaque 500.
      const invalid = emailIds.filter(id => !mongoose.isValidObjectId(id));
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'Invalid emailIds', invalid });
      }

      // Soft-delete emails that belong to this user (deleteMany is overridden by soft-delete plugin)
      const result = await IngestedEmailModel.deleteMany({ _id: { $in: emailIds }, userId });
      return res.json({ deletedCount: result.deletedCount });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
