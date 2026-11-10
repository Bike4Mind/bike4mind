import { FeedbackModel } from '@bike4mind/database';
import { z } from 'zod';
import { recordFeedbackReadBy } from '../../utils/feedbackReadAudit';
import { hydrateFeedbackText, toRedactedFeedback } from '../../utils/redactedFeedback';
import { adminAssistantAuditWriter } from '../auditWriter';
import { defineAdminTool } from '../defineAdminTool';
import { resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefFields, withExactlyOneUserRef } from '../schemas';

const MAX_TEXT_CHARS = 500;

// promptMeta and userEmail are deliberately not selected. contentStored is required by hydrateFeedbackText.
const FEEDBACK_SELECT = 'userId content contentStored status type subject createdAt';

const GetUserFeedbackInput = withExactlyOneUserRef(
  AdminUserRefFields.extend({
    limit: z.number().int().min(1).max(20).default(10).describe('Maximum feedback reports to return (1-20).'),
  })
);

const TOOL_NAME = 'admin_get_user_feedback';

export const getUserFeedbackTool = defineAdminTool({
  name: TOOL_NAME,
  description:
    'Read the most recent feedback reports a user submitted, newest first, with text truncated to 500 characters.',
  input: GetUserFeedbackInput,
  run: async ({ userId, email, limit }, context) => {
    const user = await resolveAdminUserRef({ userId, email });
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };

    const docs = await FeedbackModel.find({ userId: user.id })
      .select(FEEDBACK_SELECT)
      .sort({ createdAt: -1 })
      .limit(limit + 1);
    const reports = docs.slice(0, limit).map(toRedactedFeedback);
    // The same feedback.viewed row GET /api/feedback writes, awaited before the text is loaded: a
    // failed write throws, and defineAdminTool fails the tool call rather than return the text.
    await recordFeedbackReadBy(
      context.user,
      adminAssistantAuditWriter(context, TOOL_NAME),
      reports.map(report => ({ id: report.id, userId: report.userId })),
      { userId: user.id, limit }
    );
    const items = await hydrateFeedbackText(reports);

    return {
      ok: true,
      data: {
        truncated: docs.length > limit,
        items: items.map(item => ({
          id: item.id,
          createdAt: new Date(item.createdAt).toISOString(),
          type: item.type,
          subject: item.subject,
          status: item.status,
          text: item.content?.slice(0, MAX_TEXT_CHARS) ?? null,
          textExpired: item.contentExpired,
        })),
      },
    };
  },
});
