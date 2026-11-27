import { ChatModels } from '@bike4mind/common';
import { DeepSeekBackend } from './deepseekBackend';
import { describeOpenAICompatibleToolFailureLogging } from './__tests__/openaiCompatibleToolFailureLogging';

describeOpenAICompatibleToolFailureLogging(
  'DeepSeekBackend',
  logger => new DeepSeekBackend('test-key', logger),
  ChatModels.DEEPSEEK_FLASH
);
