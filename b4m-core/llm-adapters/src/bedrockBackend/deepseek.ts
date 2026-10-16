import { ChatModels, type ModelInfo, ModelBackend } from '@bike4mind/common';
import { ConverseBedrockBackend } from './converse';

const DEEPSEEK_BEDROCK_MODELS: readonly ModelInfo[] = [
  {
    id: ChatModels.DEEPSEEK_R1_BEDROCK,
    type: 'text',
    name: 'DeepSeek R1',
    backend: ModelBackend.Bedrock,
    contextWindow: 128_000,
    supportsImageVariation: false,
    max_tokens: 32_768,
    can_stream: true,
    pricing: {
      // $0.00135 / 1,000 Input tokens, $0.0054 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
      32_768: { input: 0.00135 / 1000, output: 0.0054 / 1000 },
    },
    supportsVision: false,
    logoFile: 'deepseek-logo.png',
    rank: 10,
    description: "DeepSeek's R1 model via AWS Bedrock. Large context window, strong reasoning, and high throughput.",
  },
  {
    id: ChatModels.DEEPSEEK_V3_1,
    type: 'text',
    name: 'DeepSeek v3.1',
    backend: ModelBackend.Bedrock,
    contextWindow: 128_000,
    supportsImageVariation: false,
    max_tokens: 32_768,
    can_stream: true,
    pricing: {
      // $0.00135 / 1,000 Input tokens, $0.0054 / 1,000 Output tokens. @see https://aws.amazon.com/bedrock/pricing/
      32_768: { input: 0.00135 / 1000, output: 0.0054 / 1000 },
    },
    supportsVision: false,
    logoFile: 'deepseek-logo.png',
    rank: 10,
    description:
      "DeepSeek's latest model via AWS Bedrock. Large context window, strong reasoning, and high throughput.",
  },
];

/**
 * DeepSeek on Bedrock goes through Converse because its raw Invoke response carries no usage
 * field at all, so Invoke could never report tokens. Text-only and toolless: neither record
 * sets supportsTools/supportsVision, so ConverseBedrockBackend sends no toolConfig or images.
 */
export default class DeepSeekBedrockBackend extends ConverseBedrockBackend {
  protected override modelTable(): readonly ModelInfo[] {
    return DEEPSEEK_BEDROCK_MODELS;
  }
}
