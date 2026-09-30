import { ChatModels } from '@bike4mind/common';
import type { AxiosInstance } from 'axios';
import type { ChatModelOption, ChatUsage } from '@shared/chat';
import { streamCompletion, supportsPromptCache } from './completions';
import type { ExploreContext } from './tools/types';

/**
 * The models `explore` asks for, best first. The mid tier rather than the small one: a haiku-class
 * model skims, and a report that misses the file the parent needed costs a full round trip on
 * the big model to recover from. Only a candidate on the session's own backend is used, so a
 * GPT session never spends on (or fails on) an Anthropic key the user did not pick.
 */
export const EXPLORE_MODELS: readonly string[] = [
  ChatModels.CLAUDE_5_SONNET,
  ChatModels.CLAUDE_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_4_6_SONNET,
  ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
  ChatModels.CLAUDE_4_5_SONNET,
  ChatModels.CLAUDE_4_5_SONNET_BEDROCK,
  ChatModels.GPT5_4_MINI,
  ChatModels.GPT5_MINI,
  ChatModels.GEMINI_3_5_FLASH,
  ChatModels.GEMINI_2_5_FLASH,
];

/**
 * Falls back to the session's own model when its backend offers none of the above, or when the
 * list could not be read: exploring on the big model still keeps the reads out of the parent's
 * context, which is half the saving.
 */
export function pickExploreModel(available: readonly ChatModelOption[], sessionModel: string): string {
  const backend = available.find(model => model.id === sessionModel)?.backend;
  if (!backend) return sessionModel;
  return (
    EXPLORE_MODELS.find(candidate => available.some(model => model.id === candidate && model.backend === backend)) ??
    sessionModel
  );
}

/**
 * An explicit pattern on the model id, so a new Opus release is covered without a list edit; widen
 * or narrow it here. Opus re-read every file an explore report quoted, so the sub-agent only
 * added its own time, cost and report tokens, which stay in the context and are re-read each round.
 */
const SKIP_EXPLORE_SESSIONS = /opus/i;

/** A same-model sub-loop would only add cost, so the tool also needs a different model to run on. */
export function shouldOfferExplore(available: readonly ChatModelOption[], sessionModel: string): boolean {
  if (SKIP_EXPLORE_SESSIONS.test(sessionModel)) return false;
  return pickExploreModel(available, sessionModel) !== sessionModel;
}

export function buildExploreContext(options: {
  axios: AxiosInstance;
  endpoint: string;
  models: readonly ChatModelOption[];
  sessionModel: string;
  onUsage(usage: ChatUsage): void;
}): ExploreContext {
  const target = (model: string) => {
    const maxTokens = options.models.find(option => option.id === model)?.maxOutputTokens;
    return { model, cache: supportsPromptCache(options.models, model), ...(maxTokens ? { maxTokens } : {}) };
  };
  return {
    ...target(pickExploreModel(options.models, options.sessionModel)),
    fallback: target(options.sessionModel),
    complete: (request, onEvent, signal) => streamCompletion(options.axios, options.endpoint, request, onEvent, signal),
    addUsage: options.onUsage,
  };
}
