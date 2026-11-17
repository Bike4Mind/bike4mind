import { ChatModels } from '@bike4mind/common';

const incompatibleModels: readonly string[] = [
  ChatModels.O1,
  ChatModels.O1_PREVIEW,
  ChatModels.O1_MINI,
  ChatModels.O3_MINI,
  ChatModels.GPT5_CHAT_LATEST,
  ChatModels.GPT5_1_CHAT_LATEST,
  ChatModels.GPT5_2_CHAT_LATEST,
];

export const isQuestMasterCompatible = (model: string): boolean => !incompatibleModels.includes(model);
