import { createHash, randomUUID } from 'node:crypto';
import { FEEDBACK_AI_POLICY, confidenceBand, type DecisionAnswer, type AdminAiAttempt } from '@bike4mind/common';
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
import { recordAdminAiAttempt } from './telemetry';
import { AdminAiSkip } from './adminAiSkip';
import { decisionFailureCode } from '@server/decisions/platformDecision';

export async function triageFeedback(feedbackId: string): Promise<void> {
  const logger = new Logger({ metadata: { service: 'feedbackAi' } });
  const claimKey = `feedbackAi:inflight:${feedbackId}`;
  const owner = randomUUID();
  let claimed = false;
  const attempt: AdminAiAttempt = {
    feature: 'feedbackTriage',
    policyVersion: FEEDBACK_AI_POLICY,
    outcome: 'skip',
    skipReason: 'error',
    calls: 0,
    knownCostUsd: 0,
    costUnknown: false,
    startedAt: new Date(),
  };
  try {
    const config = await loadFeedbackAiConfig();
    const feature = config.features.feedbackTriage;
    if (!config.enabled || feature.mode === 'off') {
      attempt.skipReason = 'disabled';
      return;
    }
    claimed = (await cacheRepository.claimDedup(claimKey, { owner }, 60_000)).claimed;
    if (!claimed) {
      attempt.skipReason = 'in_flight';
      return;
    }
    const report = await FeedbackModel.findById(feedbackId).select('createdAt status subject type').lean();
    const text = await FeedbackTextModel.findById(feedbackId).lean();
    if (!report || !text || text.expiresAt <= new Date() || !text.content.trim()) return;
    const evidence = pseudonymiseEvidence(
      { content: text.content.slice(0, 3000), subject: report.subject, type: report.type },
      ''
    );
    const inputHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    const previous = await FeedbackAiModel.findOne({ feedbackId }).lean();
    if (previous?.inputHash === inputHash && previous.suggestionId) {
      attempt.outcome = 'cached';
      attempt.suggestionId = previous.suggestionId;
      attempt.skipReason = undefined;
      return;
    }
    const model = await callablePlatformModel({ enabled: true, model: feature.model }, logger);
    const embedded = await embedAdminAi('feedbackTriage', JSON.stringify(evidence));
    if (!embedded.ok) {
      attempt.skipReason = embedded.skip;
      return;
    }
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
      let costUsd = 0;
      const started = Date.now();
      // Single-question calls work with every decision provider's question limit.
      const results = await Promise.allSettled(
        feedbackQuestions(candidates.length).map(async question => {
          const fresh = await loadFeedbackAiConfig();
          if (!fresh.enabled || fresh.features.feedbackTriage.mode === 'off') throw new AdminAiSkip('disabled');
          const accounting = adminAiDecisionAccounting(
            {
              feature: 'feedbackTriage',
              limits: { ...fresh.features.feedbackTriage, monthlyCapUsd: fresh.monthlyCapUsd },
              onCost: cost => {
                costUsd += cost;
                attempt.knownCostUsd += cost;
              },
              onCall: delta => {
                attempt.calls += delta;
              },
              onUnknownCost: () => {
                attempt.costUnknown = true;
              },
            },
            logger
          );
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
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const answers: DecisionAnswer[] = results.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
      const output = readFeedbackAnswers(
        answers,
        candidates.map(c => c.id)
      );
      suggestion = await adminAiSuggestionRepository.createPending({
        ...key,
        entityType: 'feedback',
        actionClass: 'labels',
        costUnknown: attempt.costUnknown,
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
    attempt.outcome = 'suggestion';
    attempt.suggestionId = suggestion.id;
    attempt.skipReason = undefined;
  } catch (error) {
    attempt.skipReason = error instanceof AdminAiSkip ? error.reason : (decisionFailureCode(error) ?? 'provider_down');
    logger.warn('Feedback AI skipped; manual report preserved', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    if (claimed) await cacheRepository.casDeleteDedup(claimKey, 'owner', owner).catch(() => undefined);
    await recordAdminAiAttempt({ ...attempt, finishedAt: new Date() }).catch(() => undefined);
  }
}
