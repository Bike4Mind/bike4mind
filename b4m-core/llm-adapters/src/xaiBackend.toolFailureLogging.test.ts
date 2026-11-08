import { ChatModels } from '@bike4mind/common';
import { XAIBackend } from './xaiBackend';
import { describeOpenAICompatibleToolFailureLogging } from './__tests__/openaiCompatibleToolFailureLogging';

describeOpenAICompatibleToolFailureLogging(
  'XAIBackend',
  logger => new XAIBackend('test-key', logger),
  ChatModels.GROK_4_5
);
