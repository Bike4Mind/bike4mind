import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guards that the transport timeout is wired onto EVERY Bedrock client we build. A Bedrock call
 * with no timeout does not error and does not return - it hangs until the caller's Lambda is
 * killed - and the client is rebuilt on every model switch, so one missed construction site is
 * enough to keep the hang live.
 *
 * This file covers the wiring only. The h2 timeout SEMANTICS - that a stall rejects, that an
 * active-but-slow response survives, and that the option names still mean something to the SDK -
 * are proven against a real client in base.requestTimeout.integration.test.ts.
 */

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

describe('Bedrock client transport timeout', () => {
  beforeEach(() => {
    clientConfigs.length = 0;
    sendMock.mockReset();
  });

  // Deferred so the mock above is installed before base.ts pulls in the SDK.
  async function makeBackend() {
    const { BaseBedrockBackend } = await import('./base');
    class TestBackend extends BaseBedrockBackend {
      formatMessages = (m: never[]) => m;
      getPayload = () => ({ modelId: 'm', contentType: 'application/json', accept: '*/*', body: '{}' });
      translateStreamChunk = () => ({ done: true });
      translateChunk = () => ({ done: true });
      pushToolMessages = () => undefined;
      getModelInfo = async () => [];
      // updateClientForModel is protected; the rebuild is what this suite has to reach.
      public rebuildFor(model: string) {
        this.updateClientForModel(model);
      }
    }
    return new TestBackend();
  }

  it('arms a requestTimeout on the client built in the constructor', async () => {
    await makeBackend();

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0].requestHandler).toEqual({
      requestTimeout: 120_000,
      sessionTimeout: 130_000,
      disableConcurrentStreams: true,
    });
  });

  // The regression that matters most: updateClientForModel throws the client away on every
  // model switch, so a handler wired only in the constructor leaves the hang live.
  it('arms a requestTimeout on the client rebuilt by updateClientForModel', async () => {
    const backend = await makeBackend();
    clientConfigs.length = 0;

    backend.rebuildFor('anthropic.claude-3-haiku-20240307-v1:0');

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0].requestHandler).toMatchObject({ requestTimeout: 120_000 });
  });

  it('keeps the retry config alongside the handler on both clients', async () => {
    const backend = await makeBackend();
    backend.rebuildFor('anthropic.claude-3-haiku-20240307-v1:0');

    expect(clientConfigs).toHaveLength(2);
    for (const config of clientConfigs) {
      expect(config).toMatchObject({ maxAttempts: 6, retryMode: 'adaptive' });
      expect(config.requestHandler).toBeDefined();
    }
  });

  // disableConcurrentStreams is the SDK's own Bedrock default; supplying our own
  // requestHandler replaces that object, so dropping it would silently change the
  // connection model from an isolated session per request to multiplexed sessions.
  it('preserves the SDK default disableConcurrentStreams', async () => {
    await makeBackend();
    expect(clientConfigs[0].requestHandler).toMatchObject({ disableConcurrentStreams: true });
  });
});
