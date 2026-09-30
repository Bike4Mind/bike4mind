import { ChatModels } from '@bike4mind/common';
import { XAIBackend } from './xaiBackend';
import { describeOpenAICompatibleArtifactDedupe } from './__tests__/openaiCompatibleArtifactDedupe';

describeOpenAICompatibleArtifactDedupe('XAIBackend', () => new XAIBackend('test-key'), ChatModels.GROK_4_5);
