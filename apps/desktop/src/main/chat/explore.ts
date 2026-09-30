import { ChatModels } from '@bike4mind/common';
import type { AxiosInstance } from 'axios';
import type { ChatModelOption, ChatUsage } from '@shared/chat';
import { streamCompletion } from './completions';
import type { ExploreContext } from './tools/types';

/**
 * The models `explore` asks for, best first. The mid tier rather than the small one: a haiku-class
 * model skims, and a report that misses the file the parent needed costs a full round trip on
 * the big model to recover from.
 */
export const EXPLORE_MODELS: readonly string[] = [
  ChatModels.CLAUDE_5_SONNET,
  ChatModels.CLAUDE_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_4_6_SONNET,
  ChatModels.CLAUDE_4_6_SONNET_BEDROCK,
  ChatModels.CLAUDE_4_5_SONNET,
  ChatModels.CLAUDE_4_5_SONNET_BEDROCK,
];

/**
 * Falls back to the session's own model when the deployment offers none of the above, or when
 * its list could not be read: exploring on the big model still keeps the reads out of the
 * parent's context, which is half the saving.
 */
export function pickExploreModel(available: readonly ChatModelOption[], sessionModel: string): string {
  return EXPLORE_MODELS.find(candidate => available.some(model => model.id === candidate)) ?? sessionModel;
}

export function buildExploreContext(options: {
  axios: AxiosInstance;
  endpoint: string;
  models: readonly ChatModelOption[];
  sessionModel: string;
  onUsage(usage: ChatUsage): void;
}): ExploreContext {
  const model = pickExploreModel(options.models, options.sessionModel);
  const maxTokens = options.models.find(option => option.id === model)?.maxOutputTokens;
  return {
    model,
    ...(maxTokens ? { maxTokens } : {}),
    complete: (request, onEvent, signal) => streamCompletion(options.axios, options.endpoint, request, onEvent, signal),
    addUsage: options.onUsage,
  };
}
