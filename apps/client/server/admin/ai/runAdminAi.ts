import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ADMIN_AI_FEATURE_ENGINE,
  ADMIN_AI_MAX_EVIDENCE_LINKS,
  ADMIN_AI_MAX_REASON_CHARS,
  ADMIN_AI_MAX_REASONS,
  AdminAiConfigSchema,
  confidenceBand,
  type AdminAiConfig,
  type AdminAiAttempt,
  type AdminAiFeature,
  type AdminAiReason,
  type AdminAiSuggestionItem,
  type DecisionAnswer,
  type DecisionModelId,
  type DecisionQuestion,
  type ModelInfo,
} from '@bike4mind/common';
import {
  adminAiSuggestionRepository,
  AdminAiAttemptModel,
  adminSettingsRepository,
  apiKeyRepository,
  cacheRepository,
} from '@bike4mind/database';
import { buildApiKeyTable, getAvailableModels, getLlmByModel, type ICompletionBackend } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { apiKeyService } from '@bike4mind/services';
import { meterCompletionBackend } from '@bike4mind/services/billing/completionMeter';
import { canonicalJson } from '@bike4mind/server-utils/mcpConnections/toolDiscovery';
import {
  OperationsModelService,
  OperationsModelUnavailableError,
} from '@bike4mind/server-utils/services/operationsModelService';
import { getSettingsByNames, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { executeDecision } from '@bike4mind/server-utils/decisions/executeDecision';
import {
  DecisionSkipped,
  callablePlatformModel,
  decisionFailureCode,
  resolveJsonInput,
} from '@bike4mind/server-utils/decisions/platformDecision';
import { AdminAiSkip, type AdminAiSkipReason } from './adminAiSkip';
import { adminAiCompletionMeter, adminAiDecisionAccounting, type AdminAiSpendLimits } from './budget';
import { pseudonymiseEvidence } from './pseudonymiseEvidence';

/** What a text-engine prompt must return; a feature schema may add fields on top. */
export const adminAiTextOutputSchema = z.object({
  verdict: z.string().min(1).max(256),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)).min(1),
  proposedAction: z.unknown().optional(),
});
export type AdminAiTextOutput = z.infer<typeof adminAiTextOutputSchema>;

export type AdminAiRunInput = {
  entityType: string;
  entityId: string;
  /** Pseudonymised before it reaches a model or the input hash. */
  evidence: unknown;
  /** Attached to every stored reason; never taken from model output. */
  evidenceLinks?: string[];
  /** Bump to re-ask for the same evidence after a prompt or question change. */
  policyVersion: string;
  actionClass?: string;
  /** Decision-engine features only. Sent verbatim, not pseudonymised: keep identifiers in `evidence`. */
  question?: DecisionQuestion;
  /** Text-engine features only. Sent verbatim, not pseudonymised: keep identifiers in `evidence`. */
  prompt?: { system: string; outputSchema: z.ZodType<AdminAiTextOutput> };
};

export type AdminAiRunResult =
  { ok: true; suggestion: AdminAiSuggestionItem; cached: boolean } | { ok: false; skip: AdminAiSkipReason };

export type AdminAiTextBackend = {
  modelInfo: ModelInfo;
  llm: Pick<ICompletionBackend, 'complete'>;
};

export type RunAdminAiDeps = {
  loadConfig?: () => Promise<AdminAiConfig>;
  callableDecisionModel?: (model: DecisionModelId | null, logger: Logger) => Promise<DecisionModelId>;
  decide?: typeof executeDecision;
  textBackend?: (model: string | null, logger: Logger) => Promise<AdminAiTextBackend>;
  now?: () => number;
  logger?: Logger;
};

// Bounds every text hold: the meter reserves the worst case for this many output tokens.
const TEXT_MAX_TOKENS = 800;
// Covers a decision call plus its retry; if a slow repair or escalation outlives it, a concurrent run
// can make a duplicate call, but createPending still stores one row per key. A run only ever releases
// its own claim, so a lapsed claim another run has since taken stays held.
const IN_FLIGHT_MS = 60_000;

type Answer = {
  model: string;
  verdict: string;
  probability: number;
  reasonTexts: string[];
  proposedAction?: unknown;
};

const loadAdminAiConfig = async (): Promise<AdminAiConfig> => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['adminAiConfig'], skipCache: true }
  );
  return getSettingsValue('adminAiConfig', settings, AdminAiConfigSchema.parse({}));
};

const callableDecisionModel = async (model: DecisionModelId | null, logger: Logger) => {
  try {
    return await callablePlatformModel({ enabled: true, model }, logger);
  } catch (error) {
    if (error instanceof DecisionSkipped) throw new AdminAiSkip('no_model');
    throw error;
  }
};

/** The operations text model when `model` is null, else that model on the system keys. */
const defaultTextBackend = async (model: string | null, logger: Logger): Promise<AdminAiTextBackend> => {
  if (!model) return OperationsModelService.getOperationsTextModel();
  const db = { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames };
  const apiKeyTable = buildApiKeyTable(await apiKeyService.getEffectiveLLMApiKeys('system', db));
  const modelInfo = (await getAvailableModels(apiKeyTable)).find(m => m.id === model);
  if (!modelInfo) throw new AdminAiSkip('no_model');
  const llm = getLlmByModel(apiKeyTable, { modelInfo, logger });
  if (!llm) throw new OperationsModelUnavailableError(`No backend for ${model}`);
  return { modelInfo, llm };
};

const asDecisionJson = (value: unknown): Record<string, unknown> | unknown[] =>
  Array.isArray(value) || (value !== null && typeof value === 'object')
    ? (value as Record<string, unknown>)
    : { value };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Reads one decision answer into a verdict and the probability behind it; a refusal is invalid output. */
const readDecisionAnswer = (answer: DecisionAnswer | undefined): Omit<Answer, 'model'> => {
  if (!answer || answer.type === 'refusal') throw new AdminAiSkip('invalid_output');
  if (answer.type === 'predicate') {
    const verdict = answer.probability >= 0.5;
    return {
      verdict: String(verdict),
      probability: verdict ? answer.probability : 1 - answer.probability,
      reasonTexts: [`Probability the statement holds: ${answer.probability.toFixed(2)}`],
    };
  }
  const options =
    answer.type === 'choice'
      ? answer.probabilities.map(p => ({ name: p.value, probability: p.probability }))
      : answer.probabilities.map(p => ({ name: p.label, probability: p.probability }));
  const ranked = options.sort((a, b) => b.probability - a.probability);
  const verdict = answer.type === 'choice' ? answer.choice : (ranked[0]?.name ?? String(Math.round(answer.score)));
  return {
    verdict,
    probability: ranked[0]?.probability ?? answer.confidence,
    reasonTexts: [ranked.map(p => `${p.name}: ${p.probability.toFixed(2)}`).join(', ')],
  };
};

const parseTextOutput = (raw: string, schema: z.ZodType<AdminAiTextOutput>) => {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false as const, error: 'The reply was not valid JSON.' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false as const, error: z.prettifyError(parsed.error) };
  return { ok: true as const, value: parsed.data };
};

const toReasons = (texts: string[], links: string[] | undefined): AdminAiReason[] => {
  const evidenceLinks = (links ?? []).slice(0, ADMIN_AI_MAX_EVIDENCE_LINKS);
  return texts
    .slice(0, ADMIN_AI_MAX_REASONS)
    .map(text => ({ text: text.slice(0, ADMIN_AI_MAX_REASON_CHARS), evidenceLinks: [...evidenceLinks] }));
};

const skipFor = (error: unknown, logger: Logger, feature: AdminAiFeature): AdminAiSkipReason => {
  if (error instanceof AdminAiSkip) return error.reason;
  if (error instanceof OperationsModelUnavailableError) return 'provider_down';
  const failure = decisionFailureCode(error);
  if (failure === 'malformed_response' || failure === 'refused') return 'invalid_output';
  if (failure === 'model_unavailable' || failure === 'provider_not_configured') return 'no_model';
  if (failure && failure !== 'invalid_request') return 'provider_down';
  logger.error('admin AI run failed', { feature, errorName: error instanceof Error ? error.name : typeof error });
  return 'error';
};

/**
 * Asks the feature's model about one entity and stores the answer as a pending suggestion. Never
 * throws: every refusal (disabled, budget, provider down, bad output) comes back as a typed skip.
 * The same pseudonymised evidence under the same policyVersion is answered from the stored row.
 */
export async function runAdminAi(
  feature: AdminAiFeature,
  input: AdminAiRunInput,
  deps: RunAdminAiDeps = {}
): Promise<AdminAiRunResult> {
  const logger = deps.logger ?? new Logger({ metadata: { service: 'adminAi', feature } });
  const attempt: AdminAiAttempt = {
    feature,
    policyVersion: input.policyVersion,
    outcome: 'running',
    calls: 0,
    knownCostUsd: 0,
    costUnknown: true,
    startedAt: new Date(),
  };
  let attemptId: string;
  try {
    attemptId = (await AdminAiAttemptModel.create(attempt)).id;
  } catch {
    return { ok: false, skip: 'error' };
  }
  attempt.costUnknown = false;
  const result = await executeAdminAi(feature, input, deps, attempt);
  try {
    await AdminAiAttemptModel.updateOne(
      { _id: attemptId },
      {
        $set: {
          ...attempt,
          outcome: result.ok ? (result.cached ? 'cached' : 'suggestion') : 'skip',
          ...(result.ok ? { suggestionId: result.suggestion.id } : { skipReason: result.skip }),
          finishedAt: new Date(),
        },
      }
    );
  } catch {
    logger.error('admin AI attempt settlement failed', { feature });
  }
  return result;
}

async function executeAdminAi(
  feature: AdminAiFeature,
  input: AdminAiRunInput,
  deps: RunAdminAiDeps,
  attempt: AdminAiAttempt
): Promise<AdminAiRunResult> {
  const logger = deps.logger ?? new Logger({ metadata: { service: 'adminAi', feature } });
  const now = deps.now ?? Date.now;
  let inflight: { key: string; owner: string } | null = null;
  try {
    const config = await (deps.loadConfig ?? loadAdminAiConfig)();
    const featureConfig = config.features[feature];
    if (!config.enabled || featureConfig.mode === 'off') return { ok: false, skip: 'disabled' };

    // Hashed after pseudonymisation, so a salt rotation re-asks rather than leaking raw values into the key.
    const payload = pseudonymiseEvidence(input.evidence);
    const inputHash = sha256(canonicalJson(payload));
    const key = { feature, entityId: input.entityId, inputHash, policyVersion: input.policyVersion };

    const existing = await adminAiSuggestionRepository.findByKey(key);
    if (existing) return { ok: true, suggestion: existing, cached: true };

    const claimKey = `adminAi:${feature}:inflight:${sha256(canonicalJson(key))}`;
    const owner = randomUUID();
    const claim = await cacheRepository.claimDedup(claimKey, { owner }, IN_FLIGHT_MS);
    if (!claim.claimed) return { ok: false, skip: 'in_flight' };
    inflight = { key: claimKey, owner };

    // A run that finished between the lookup above and this claim has already stored the row.
    const stored = await adminAiSuggestionRepository.findByKey(key);
    if (stored) return { ok: true, suggestion: stored, cached: true };

    const started = now();
    let costUsd = 0;
    const adapter = {
      feature,
      limits: {
        monthlyCapUsd: config.monthlyCapUsd,
        dailyBudgetUsd: featureConfig.dailyBudgetUsd,
        maxCallsPerDay: featureConfig.maxCallsPerDay,
      } satisfies AdminAiSpendLimits,
      onCost: (usd: number) => {
        if (Number.isFinite(usd) && usd >= 0) {
          costUsd += usd;
          attempt.knownCostUsd += usd;
        } else attempt.costUnknown = true;
      },
      onCall: (delta: number) => {
        attempt.calls += delta;
      },
      onUnknownCost: () => {
        attempt.costUnknown = true;
      },
    };

    const askDecision = async (model: string | null): Promise<Answer> => {
      const { question } = input;
      if (!question) throw new Error('decision feature called without a question');
      const resolved = await (deps.callableDecisionModel ?? callableDecisionModel)(
        model as DecisionModelId | null,
        logger
      );
      const { response } = await (deps.decide ?? executeDecision)({
        model: resolved,
        body: { input: [{ type: 'json', json: asDecisionJson(payload) }], questions: [question] },
        logger,
        accounting: adminAiDecisionAccounting(adapter, logger),
        resolveInput: resolveJsonInput,
      });
      return { model: response.model || resolved, ...readDecisionAnswer(response.answers[0]) };
    };

    const askText = async (model: string | null): Promise<Answer> => {
      const { prompt } = input;
      if (!prompt) throw new Error('text feature called without a prompt');
      const backend = await (deps.textBackend ?? defaultTextBackend)(model, logger);
      const llm = meterCompletionBackend(backend.llm, adminAiCompletionMeter(adapter), backend.modelInfo);
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: `${prompt.system}\n\nReply with one JSON object only, no prose.` },
        { role: 'user', content: JSON.stringify(payload) },
      ];
      const complete = async () => {
        let raw = '';
        try {
          await llm.complete(
            backend.modelInfo.id,
            messages,
            { temperature: 0, maxTokens: TEXT_MAX_TOKENS, stream: false },
            async parts => {
              raw += parts.filter(Boolean).join('');
            }
          );
        } catch (error) {
          if (error instanceof AdminAiSkip) throw error;
          logger.warn('admin AI text call failed', {
            feature,
            errorName: error instanceof Error ? error.name : 'unknown',
          });
          throw new AdminAiSkip('provider_down');
        }
        return raw;
      };

      const first = await complete();
      let parsed = parseTextOutput(first, prompt.outputSchema);
      if (!parsed.ok) {
        // Exactly one repair, carrying the validation error back to the model.
        messages.push(
          { role: 'assistant', content: first.slice(0, 4000) },
          {
            role: 'user',
            content: `That reply was rejected: ${parsed.error.slice(0, 1000)}\nReply again with the corrected JSON object only.`,
          }
        );
        parsed = parseTextOutput(await complete(), prompt.outputSchema);
        if (!parsed.ok) throw new AdminAiSkip('invalid_output');
      }
      const { verdict, confidence, reasons, proposedAction } = parsed.value;
      return { model: backend.modelInfo.id, verdict, probability: confidence, reasonTexts: reasons, proposedAction };
    };

    const ask = ADMIN_AI_FEATURE_ENGINE[feature] === 'decision' ? askDecision : askText;
    let answer = await ask(featureConfig.model);
    let escalated = false;
    if (answer.probability < featureConfig.confidenceThreshold && featureConfig.escalationModel) {
      // The primary answer is already paid for; a failed escalation stores it rather than discarding it.
      try {
        answer = await ask(featureConfig.escalationModel);
        escalated = true;
      } catch (error) {
        logger.warn('admin AI escalation failed; keeping the primary answer', {
          feature,
          skip: skipFor(error, logger, feature),
        });
      }
    }

    const suggestion = await adminAiSuggestionRepository.createPending({
      ...key,
      entityType: input.entityType,
      actionClass: input.actionClass,
      costUnknown: attempt.costUnknown,
      model: answer.model,
      escalated,
      verdict: answer.verdict,
      confidence: { band: confidenceBand(answer.probability), probability: answer.probability },
      reasons: toReasons(answer.reasonTexts, input.evidenceLinks),
      proposedAction: answer.proposedAction ?? null,
      costUsd,
      latencyMs: Math.max(0, now() - started),
    });
    return { ok: true, suggestion, cached: false };
  } catch (error) {
    return { ok: false, skip: skipFor(error, logger, feature) };
  } finally {
    if (inflight) await cacheRepository.casDeleteDedup(inflight.key, 'owner', inflight.owner).catch(() => undefined);
  }
}
