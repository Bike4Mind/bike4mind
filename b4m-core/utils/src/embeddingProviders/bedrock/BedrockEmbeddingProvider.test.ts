import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEmbeddingModelCapabilities, BedrockEmbeddingModel } from '@bike4mind/common';
import { describeEmbeddingProviderConformance, fakeEmbedding, LATE_FAILURE_INPUT } from '../conformance';

const clientConfigs: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
    send = vi.fn();
  },
  InvokeModelCommand: class {
    constructor(readonly input: { modelId: string; body: string }) {}
  },
}));

const { BedrockEmbeddingProvider } = await import('./BedrockEmbeddingProvider');

type SentCommand = { input: { modelId: string; body: string } };
type FakeClient = { send: (command: SentCommand) => Promise<{ body: Uint8Array }> };

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

let sent: SentCommand[] = [];
let respond: (command: SentCommand) => Promise<{ body: Uint8Array }>;

const succeeds = (command: SentCommand) => {
  const { inputText } = JSON.parse(command.input.body) as { inputText: string };
  const { native } = getEmbeddingModelCapabilities(command.input.modelId as BedrockEmbeddingModel).dimensions;
  return Promise.resolve({ body: encode({ embedding: fakeEmbedding(inputText, native), inputTextTokenCount: 4 }) });
};

const client: FakeClient = {
  send: command => {
    sent.push(command);
    return respond(command);
  },
};

const provider = () => new BedrockEmbeddingProvider({ client: client as never });

beforeEach(() => {
  sent = [];
  respond = succeeds;
});

describeEmbeddingProviderConformance('Bedrock', {
  provider,
  requestCount: () => sent.length,
  scenarios: {
    succeeds: () => (respond = succeeds),
    failsOnLateInput: () => {
      respond = command =>
        JSON.parse(command.input.body).inputText === LATE_FAILURE_INPUT
          ? Promise.reject(new Error('bad input'))
          : succeeds(command);
    },
  },
});

describe('BedrockEmbeddingProvider', () => {
  const model = BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2;

  it('sends one Titan request per input and sums the reported token counts', async () => {
    const result = await provider().embed({ model, inputs: ['a', 'b', 'c'] });

    expect(sent.map(command => JSON.parse(command.input.body))).toEqual([
      { inputText: 'a' },
      { inputText: 'b' },
      { inputText: 'c' },
    ]);
    expect(sent.every(command => command.input.modelId === model)).toBe(true);
    expect(result.inputTokens).toBe(12);
  });

  it('keeps at most 8 requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    respond = async command => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2));
      inFlight--;
      return succeeds(command);
    };

    await provider().embed({ model, inputs: Array.from({ length: 30 }, (_, index) => `t${index}`) });
    expect(peak).toBe(8);
  });

  it('fails the whole call when one response cannot be parsed', async () => {
    respond = command =>
      JSON.parse(command.input.body).inputText === 'bad'
        ? Promise.resolve({ body: new TextEncoder().encode('not json') })
        : succeeds(command);

    await expect(provider().embed({ model, inputs: ['ok', 'bad'] })).rejects.toThrow(
      'Failed to parse Bedrock embedding response'
    );
  });

  it('treats a response without an embedding as a parse failure', async () => {
    respond = () => Promise.resolve({ body: encode({ inputTextTokenCount: 1 }) });
    await expect(provider().embed({ model, inputs: ['a'] })).rejects.toThrow(
      'Failed to parse Bedrock embedding response'
    );
  });

  it('leaves inputTokens undefined when no response reports a count', async () => {
    respond = () => Promise.resolve({ body: encode({ embedding: new Array(1024).fill(0) }) });
    expect((await provider().embed({ model, inputs: ['a'] })).inputTokens).toBeUndefined();
  });

  describe('default client credentials', () => {
    beforeEach(() => {
      clientConfigs.length = 0;
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('leaves the default credential chain alone on hosted', () => {
      vi.stubEnv('B4M_SELF_HOST', '');
      vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
      new BedrockEmbeddingProvider();

      expect(clientConfigs).toHaveLength(1);
      expect(clientConfigs[0]).not.toHaveProperty('credentials');
    });

    it('signs with the BEDROCK_AWS_* pair on self-host', () => {
      vi.stubEnv('B4M_SELF_HOST', 'true');
      vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
      vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      new BedrockEmbeddingProvider();

      expect(clientConfigs[0].credentials).toEqual({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      });
    });
  });
});
