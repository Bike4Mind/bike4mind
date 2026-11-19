import { ChatModels } from '@bike4mind/common';

const incompatibleModels: readonly string[] = [
  // O-series reasoning models (no tool calling in streaming mode)
  ChatModels.O1,
  ChatModels.O1_PREVIEW,
  ChatModels.O1_MINI,
  ChatModels.O3_MINI,
  // GPT-5 chat-latest models have supportsTools: false; other GPT-5 models use function calling
  ChatModels.GPT5_CHAT_LATEST,
  ChatModels.GPT5_1_CHAT_LATEST,
  ChatModels.GPT5_2_CHAT_LATEST,
];

export const isQuestMasterCompatible = (model: string): boolean => !incompatibleModels.includes(model);
