import { ChatModels } from '@bike4mind/common';
import { KimiBackend } from './kimiBackend';
import { describeOpenAICompatibleArtifactDedupe } from './__tests__/openaiCompatibleArtifactDedupe';

describeOpenAICompatibleArtifactDedupe('KimiBackend', () => new KimiBackend('test-key'), ChatModels.KIMI_K2_6);
