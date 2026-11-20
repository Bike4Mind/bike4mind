import { ChatModels } from '@bike4mind/common';
import { KimiBackend } from './kimiBackend';
import { describeOpenAICompatibleToolFailureLogging } from './__tests__/openaiCompatibleToolFailureLogging';

describeOpenAICompatibleToolFailureLogging(
  'KimiBackend',
  logger => new KimiBackend('test-key', logger),
  ChatModels.KIMI_K2_6
);
