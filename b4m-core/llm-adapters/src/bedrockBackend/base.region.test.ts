import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatModels } from '@bike4mind/common';

const sendMock = vi.fn();
const clientConfigs: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
    send = sendMock;
  },
  InvokeModelCommand: class {},
  InvokeModelWithResponseStreamCommand: class {},
}));

describe('Bedrock client region routing', () => {
  beforeEach(() => {
    clientConfigs.length = 0;
    sendMock.mockReset();
  });

  async function makeBackend() {
    const { BaseBedrockBackend } = await import('./base');
    class TestBackend extends BaseBedrockBackend {
      formatMessages = (m: never[]) => m;
      getPayload = () => ({ modelId: 'm', contentType: 'application/json', accept: '*/*', body: '{}' });
      translateStreamChunk = () => ({ done: true });
      translateChunk = () => ({ done: true });
      pushToolMessages = () => undefined;
      getModelInfo = async () => [];
      public rebuildFor(model: string) {
        this.updateClientForModel(model);
      }
    }
    return new TestBackend();
  }

  it.each([
    [ChatModels.CLAUDE_3_HAIKU_BEDROCK, 'us-east-1'],
    [ChatModels.CLAUDE_3_5_HAIKU_BEDROCK, 'us-east-2'],
    [ChatModels.CLAUDE_5_SONNET_BEDROCK, 'us-east-2'],
    ['global.anthropic.claude-sonnet-5-5', 'us-east-2'],
    ['anthropic.claude-3-5-haiku-20241022-v1:0', 'us-east-2'],
    ['global.meta.llama4-scout-17b-instruct-v1:0', 'us-east-2'],
  ])('routes %s through %s', async (model, region) => {
    const backend = await makeBackend();
    clientConfigs.length = 0;

    backend.rebuildFor(model);

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0].region).toBe(region);
  });
});
