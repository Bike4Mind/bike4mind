import { createHash, randomUUID } from 'node:crypto';
import { FEEDBACK_AI_POLICY, confidenceBand, type DecisionAnswer } from '@bike4mind/common';
import {
  FeedbackAiModel,
  FeedbackModel,
  FeedbackTextModel,
  adminAiSuggestionRepository,
  cacheRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { executeDecision } from '@server/decisions/executeDecision';
import { callablePlatformModel, resolveJsonInput } from '@server/decisions/platformDecision';
import { adminAiDecisionAccounting } from './budget';
import { embedAdminAi, loadFeedbackAiConfig } from './embedAdminAi';
import { feedbackQuestions, nearestFeedback, readFeedbackAnswers } from './feedbackDecision';
import { pseudonymiseEvidence } from './pseudonymiseEvidence';

export async function triageFeedback(feedbackId: string): Promise<void> {
  const logger = new Logger({ metadata: { service: 'feedbackAi' } });
  const claimKey = `feedbackAi:inflight:${feedbackId}`;
  const owner = randomUUID();
  let claimed = false;
  try {
    const config = await loadFeedbackAiConfig();
    const feature = config.features.feedbackTriage;
    if (!config.enabled || feature.mode === 'off') return;
    claimed = (await cacheRepository.claimDedup(claimKey, { owner }, 60_000)).claimed;
    if (!claimed) return;
    const report = await FeedbackModel.findById(feedbackId).select('createdAt status subject type').lean();
    const text = await FeedbackTextModel.findById(feedbackId).lean();
    if (!report || !text || text.expiresAt <= new Date() || !text.content.trim()) return;
    const evidence = pseudonymiseEvidence(
      { content: text.content.slice(0, 3000), subject: report.subject, type: report.type },
      ''
    );
    const inputHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    const previous = await FeedbackAiModel.findOne({ feedbackId }).lean();
    if (previous?.inputHash === inputHash && previous.suggestionId) return;
    const embedded = await embedAdminAi('feedbackTriage', JSON.stringify(evidence));
    if (!embedded.ok) return;
    // Retained, recent reports only: no full-corpus scan or re-embedding on each submission.
    const earlier = await FeedbackAiModel.find({
      model: embedded.model,
      reportCreatedAt: { $lt: report.createdAt },
      expiresAt: { $gt: new Date() },
    })
      .select('+vector')
      .sort({ reportCreatedAt: -1 })
      .limit(500)
      .lean();
    const nearest = nearestFeedback(
      embedded.vector,
      earlier.map(c => ({ id: c.feedbackId, vector: c.vector }))
    );
    const texts = await FeedbackTextModel.find({
      _id: { $in: nearest.map(c => c.id) },
      expiresAt: { $gt: new Date() },
    }).lean();
    const ids = new Set(
      (
        await FeedbackModel.find({ _id: { $in: nearest.map(c => c.id) } })
          .select('_id')
          .lean()
      ).map(r => String(r._id))
    );
    const candidates = nearest.filter(c => ids.has(c.id) && texts.some(t => String(t._id) === c.id));
    const candidateData = candidates.map((c, i) => ({
      candidate: `candidate_${i}`,
      content: texts.find(t => String(t._id) === c.id)!.content.slice(0, 1000),
    }));
    const payload = pseudonymiseEvidence({ report: evidence, candidates: candidateData }, '');
    const key = {
      feature: 'feedbackTriage' as const,
      entityId: feedbackId,
      inputHash,
      policyVersion: FEEDBACK_AI_POLICY,
    };
    let suggestion = await adminAiSuggestionRepository.findByKey(key);
    if (!suggestion) {
      const model = await callablePlatformModel({ enabled: true, model: feature.model }, logger);
      let costUsd = 0;
      const accounting = adminAiDecisionAccounting(
        {
          feature: 'feedbackTriage',
          limits: { ...feature, monthlyCapUsd: config.monthlyCapUsd },
          onCost: cost => {
            costUsd += cost;
          },
        },
        logger
      );
      const started = Date.now();
      // Single-question calls work with every decision provider's question limit.
      const results = await Promise.all(
        feedbackQuestions(candidates.length).map(async question => {
          const { response } = await executeDecision({
            model,
            body: { input: [{ type: 'json', json: payload as Record<string, unknown> }], questions: [question] },
            logger,
            accounting,
            resolveInput: resolveJsonInput,
          });
          return response.answers;
        })
      );
      const answers: DecisionAnswer[] = results.flat();
      const output = readFeedbackAnswers(
        answers,
        candidates.map(c => c.id)
      );
      suggestion = await adminAiSuggestionRepository.createPending({
        ...key,
        entityType: 'feedback',
        model,
        verdict: `${output.labels.area}: ${output.labels.severity}`,
        confidence: { probability: output.confidence, band: confidenceBand(output.confidence) },
        reasons: [{ text: 'Advisory labels and similar reports; review before acting.', evidenceLinks: [] }],
        proposedAction: output.labels,
        costUsd,
        latencyMs: Date.now() - started,
      });
    }
    const currentText = await FeedbackTextModel.findById(feedbackId).lean();
    if (!currentText || currentText.content !== text.content || !(await FeedbackModel.exists({ _id: feedbackId })))
      return;
    await FeedbackAiModel.updateOne(
      { feedbackId },
      {
        $set: {
          inputHash,
          model: embedded.model,
          vector: embedded.vector,
          suggestionId: suggestion.id,
          labels: suggestion.proposedAction,
          similar: candidates,
          reportCreatedAt: report.createdAt,
          expiresAt: text.expiresAt,
        },
        $unset: { override: 1 },
      },
      { upsert: true }
    );
  } catch (error) {
    logger.warn('Feedback AI skipped; manual report preserved', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    if (claimed) await cacheRepository.casDeleteDedup(claimKey, 'owner', owner).catch(() => undefined);
  }
}
