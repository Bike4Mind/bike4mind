import {
  FEEDBACK_AI_POLICY,
  FeedbackAiDecisionSchema,
  FeedbackAiLabelsSchema,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@bike4mind/common';
import { FeedbackAiModel, FeedbackModel, adminAiSuggestionRepository, withTransaction } from '@bike4mind/database';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { adminApi } from '@server/middlewares/adminApi';
import { feedbackAiVisible } from '@server/admin/ai/feedbackVisibility';

const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { GET: ['support:read', 'users:moderate'], PATCH: 'users:moderate' },
})
  .get(async (req, res) => {
    const id = String(req.query.id ?? '');
    if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');
    if (!(await feedbackAiVisible())) return res.json({ suggestion: null, labels: null, similar: [] });
    if (!(await FeedbackModel.exists({ _id: id }))) return res.json({ suggestion: null, labels: null, similar: [] });
    const row = await FeedbackAiModel.findOne({ feedbackId: id, expiresAt: { $gt: new Date() } }).lean();
    const suggestion = await adminAiSuggestionRepository.findLatestForEntity('feedbackTriage', id);
    if (
      !row ||
      !suggestion ||
      !['pending', 'accepted', 'overridden'].includes(suggestion.status) ||
      row.suggestionId !== suggestion.id ||
      suggestion.policyVersion !== FEEDBACK_AI_POLICY
    )
      return res.json({ suggestion: null, labels: null, similar: [] });
    const existing = await FeedbackModel.find({ _id: { $in: row.similar.map(c => c.id) } })
      .select('_id')
      .lean();
    const ids = new Set(existing.map(r => String(r._id)));
    return res.json({
      suggestion: {
        id: suggestion.id,
        labels: FeedbackAiLabelsSchema.parse(suggestion.proposedAction),
        probability: suggestion.confidence.probability,
        model: suggestion.model,
        createdAt: suggestion.createdAt,
        status: suggestion.status,
      },
      labels: row.override || row.labels ? FeedbackAiLabelsSchema.parse(row.override ?? row.labels) : null,
      similar: row.similar.filter(c => ids.has(c.id)).map(c => ({ id: c.id, similarity: c.similarity })),
    });
  })
  .patch(async (req, res) => {
    const id = String(req.query.id ?? '');
    if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');
    if (!(await feedbackAiVisible())) throw new ConflictError('Feedback suggestions are not ready for review');
    const { suggestionId, labels, reason } = FeedbackAiDecisionSchema.parse(req.body);
    await withTransaction(async () => {
      const report = await FeedbackModel.findById(id).select('userId createdAt').lean();
      const row = await FeedbackAiModel.findOne({
        feedbackId: id,
        suggestionId,
        expiresAt: { $gt: new Date() },
      }).lean();
      const suggestion = await adminAiSuggestionRepository.findLatestForEntity('feedbackTriage', id);
      if (
        !report ||
        !row ||
        !suggestion ||
        suggestion.id !== suggestionId ||
        suggestion.status !== 'pending' ||
        suggestion.policyVersion !== FEEDBACK_AI_POLICY
      )
        throw new ConflictError('This suggestion changed. Refresh and try again.');
      if (
        labels.duplicateId &&
        !(await FeedbackModel.exists({ _id: labels.duplicateId, createdAt: { $lt: report.createdAt } }))
      )
        throw new BadRequestError('Duplicate must name an earlier report');
      const original = FeedbackAiLabelsSchema.parse(suggestion.proposedAction);
      const accepted = Object.keys(original).every(
        key => original[key as keyof typeof original] === labels[key as keyof typeof labels]
      );
      const decision = await adminAiSuggestionRepository.transition(
        suggestionId,
        ['pending'],
        accepted ? 'accepted' : 'overridden',
        {
          decidedBy: { userId: req.user!.impersonatedBy ?? req.user!.id, name: req.user!.username || 'Admin' },
          overrideAction: labels,
          overrideReason: reason,
        }
      );
      if (!decision) throw new ConflictError('This suggestion was already reviewed');
      await FeedbackAiModel.updateOne({ feedbackId: id, suggestionId }, { $set: { override: labels } });
      const audit = await recordAdminActionFromRequest(req, {
        action: 'feedback.ai_labels_changed',
        target: await userAuditTarget(report.userId),
        summary: 'Reviewed feedback labels',
        reason,
        changes: [{ field: 'feedbackLabels', before: original, after: labels }],
        details: { feedbackId: id, aiSuggestionId: suggestionId },
      });
      if (!audit) throw new Error('Feedback label changes require an audit entry');
    });
    return res.json({ ok: true });
  });

export const config = { api: { externalResolver: true } };
export default handler;
