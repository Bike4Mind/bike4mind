import { ChatModels } from '@bike4mind/common';
import { DeepSeekBackend } from './deepseekBackend';
import { describeOpenAICompatibleArtifactDedupe } from './__tests__/openaiCompatibleArtifactDedupe';

describeOpenAICompatibleArtifactDedupe(
  'DeepSeekBackend',
  () => new DeepSeekBackend('test-key'),
  ChatModels.DEEPSEEK_FLASH
);
