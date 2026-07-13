import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { User, Session, Agent } from '@bike4mind/database';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { Types } from 'mongoose';
import { BadRequestError } from '@server/utils/errors';

const KeywordRoutingRuleSchema = z.object({
  keywords: z
    .array(z.string().min(1).max(100))
    .min(1, 'At least one keyword is required')
    .max(20, 'Maximum 20 keywords per rule'),
  notebookId: z.string().min(1),
});

const SlackSettingsSchema = z.object({
  slackUserId: z.string().optional(),
  defaultNotebookId: z.string().optional(),
  autoCreateNotebook: z.boolean().optional(),
  notebookNamePrefix: z.string().optional(),
  defaultProjectId: z.string().optional(),
  agentNotebookRouting: z
    .object({
      dev: z.string().optional(),
      pm: z.string().optional(),
      analyst: z.string().optional(),
      researcher: z.string().optional(),
      agent: z.string().optional(),
    })
    .optional(),
  keywordRouting: z.array(KeywordRoutingRuleSchema).max(10, 'Maximum 10 routing rules').optional(),
  customAgentId: z.string().optional(),
  githubNotifications: z
    .object({
      enabled: z.boolean(),
      githubUsername: z
        .string()
        .max(39)
        .transform(s => s.toLowerCase())
        .optional(),
      prOpened: z.boolean().optional(),
      prReviewRequested: z.boolean().optional(),
      prApproved: z.boolean().optional(),
      prChangesRequested: z.boolean().optional(),
      prMerged: z.boolean().optional(),
      ciFailed: z.boolean().optional(),
      ciPassed: z.boolean().optional(),
      mentions: z.boolean().optional(),
      channels: z
        .object({
          default: z.string().optional(),
          ciAlerts: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
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
        const slackSettings = SlackSettingsSchema.parse(req.body);

        // Validate and sanitize keyword routing rules
        if (slackSettings.keywordRouting && slackSettings.keywordRouting.length > 0) {
          const notebookIds = slackSettings.keywordRouting.map(rule => rule.notebookId);
          const uniqueNotebookIds = Array.from(new Set(notebookIds));

          // Verify all notebooks exist and belong to the user
          const notebooks = await Session.find({
            _id: { $in: uniqueNotebookIds },
            userId: userId,
            deletedAt: { $exists: false },
          }).select('_id');

          const validNotebookIds = new Set(notebooks.map((n: { _id: { toString: () => string } }) => n._id.toString()));

          for (const notebookId of uniqueNotebookIds) {
            if (!validNotebookIds.has(notebookId)) {
              return res.status(400).json({
                error: `Notebook ${notebookId} not found or does not belong to you`,
              });
            }
          }

          // Sanitize keywords: lowercase and trim whitespace
          slackSettings.keywordRouting = slackSettings.keywordRouting.map(rule => ({
            ...rule,
            keywords: rule.keywords.map(kw => kw.toLowerCase().trim()).filter(kw => kw.length > 0),
          }));

          // Filter out rules with empty keywords after sanitization
          slackSettings.keywordRouting = slackSettings.keywordRouting.filter(rule => rule.keywords.length > 0);
        }

        // Check if Slack ID is already in use by another user
        if (slackSettings.slackUserId) {
          const existingUser = await User.findOne({
            'slackSettings.slackUserId': slackSettings.slackUserId,
            _id: { $ne: userId },
          });

          if (existingUser) {
            Logger.warn(`Slack ID already in use`, {
              slackUserId: slackSettings.slackUserId,
              requestingUserId: userId,
              existingUserId: existingUser.id,
            });
            return res.status(409).json({
              error:
                'This Slack Member ID is already linked to another account. Each Slack ID can only be linked to one account.',
            });
          }
        }

        // Validate custom agent exists and is accessible to user
        if (slackSettings.customAgentId) {
          if (!Types.ObjectId.isValid(slackSettings.customAgentId)) {
            throw new BadRequestError('Invalid agent ID format');
          }

          const agent = await Agent.findOne({
            _id: slackSettings.customAgentId,
            $or: [{ userId }, { 'users.userId': userId }],
            deletedAt: { $exists: false },
          });

          if (!agent) {
            throw new BadRequestError('Selected custom agent not found or not accessible');
          }
        }

        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { $set: { slackSettings } },
          { new: true, runValidators: true }
        );

        if (!updatedUser) {
          return res.status(404).json({ error: 'User not found' });
        }

        Logger.info(`Updated Slack settings for user ${userId}`);
        return res.json({
          message: 'Slack settings updated successfully',
          slackSettings: updatedUser.slackSettings,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({
            error: 'Invalid settings data',
            details: error.issues,
          });
        }

        // Handle MongoDB duplicate key error (from unique index)
        if ((error as any).code === 11000) {
          return res.status(409).json({
            error:
              'This Slack Member ID is already linked to another account. Each Slack ID can only be linked to one account.',
          });
        }

        Logger.error('Error updating Slack settings:', error);
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
        const user = await User.findById(userId).select('slackSettings');
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        // slackUserToken is select:false, but a parent-level inclusion projection
        // (.select('slackSettings')) can re-include the child on some Mongoose
        // versions -- strip it unconditionally so the token never reaches the client.
        const { slackUserToken: _token, ...slackSettings } = (user.slackSettings ?? {}) as Record<string, unknown>;
        return res.json({ slackSettings });
      } catch (error) {
        Logger.error('Error fetching Slack settings:', error);
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
