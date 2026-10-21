import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BedrockGuardrailsService, FlaggedContentError } from './index';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BedrockRuntimeClient: vi.fn(function (this: any) {
    this.send = mockSend;
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ApplyGuardrailCommand: vi.fn(function (this: any, input: unknown) {
    this.input = input;
  }),
}));

vi.mock('@bike4mind/common', () => ({
  bedrockClientConfig: vi.fn().mockReturnValue({}),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BedrockGuardrailsService', () => {
  it('does not throw when guardrail does not intervene', async () => {
    mockSend.mockResolvedValue({ action: 'NONE', assessments: [] });

    const svc = new BedrockGuardrailsService('gid', 'DRAFT', mockLogger as any);
    await expect(svc.checkPrompt('hello')).resolves.toBeUndefined();
  });

  it('throws FlaggedContentError with topic name when a topic is blocked', async () => {
    mockSend.mockResolvedValue({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [{ topicPolicy: { topics: [{ name: 'Violence', action: 'BLOCKED' }] } }],
    });

    const svc = new BedrockGuardrailsService('gid', 'DRAFT', mockLogger as any);
    const err = await svc.checkPrompt('hurt someone').catch(e => e);
    expect(err).toBeInstanceOf(FlaggedContentError);
    expect((err as FlaggedContentError).categories).toEqual(['Violence']);
  });

  it('throws FlaggedContentError with filter type when a content-filter is blocked', async () => {
    mockSend.mockResolvedValue({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [{ contentPolicy: { filters: [{ type: 'HATE', action: 'BLOCKED' }] } }],
    });

    const svc = new BedrockGuardrailsService('gid', '1', mockLogger as any);
    const err = await svc.checkPrompt('bad content').catch(e => e);
    expect(err).toBeInstanceOf(FlaggedContentError);
    expect((err as FlaggedContentError).categories).toContain('HATE');
  });

  it('does NOT throw when GUARDRAIL_INTERVENED has no BLOCKED entries (e.g. PII anonymization)', async () => {
    mockSend.mockResolvedValue({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          sensitiveInformationPolicy: {
            piiEntities: [{ type: 'EMAIL', action: 'ANONYMIZED' }],
          },
        },
      ],
    });

    const svc = new BedrockGuardrailsService('gid', 'DRAFT', mockLogger as any);
    await expect(svc.checkPrompt('my email is x@y.com')).resolves.toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('no BLOCKED entries'), expect.any(Object));
  });

  it('collects categories from wordPolicy, sensitiveInformationPolicy, and contextualGroundingPolicy', async () => {
    mockSend.mockResolvedValue({
      action: 'GUARDRAIL_INTERVENED',
      assessments: [
        {
          wordPolicy: {
            customWords: [{ match: 'badword', action: 'BLOCKED' }],
            managedWordLists: [{ type: 'PROFANITY', action: 'BLOCKED' }],
          },
          sensitiveInformationPolicy: {
            piiEntities: [{ type: 'SSN', action: 'BLOCKED' }],
            regexes: [{ name: 'my-regex', action: 'BLOCKED' }],
          },
          contextualGroundingPolicy: {
            filters: [{ type: 'GROUNDING', action: 'BLOCKED' }],
          },
        },
      ],
    });

    const svc = new BedrockGuardrailsService('gid', 'DRAFT', mockLogger as any);
    const err = await svc.checkPrompt('secret text').catch(e => e);
    expect(err).toBeInstanceOf(FlaggedContentError);
    expect((err as FlaggedContentError).categories).toEqual(
      expect.arrayContaining(['word:badword', 'word:PROFANITY', 'pii:SSN', 'regex:my-regex', 'grounding:GROUNDING'])
    );
  });

  it('sends the prompt with correct guardrail identifier, version, and source INPUT', async () => {
    mockSend.mockResolvedValue({ action: 'NONE', assessments: [] });

    const svc = new BedrockGuardrailsService('my-id', '3', mockLogger as any);
    await svc.checkPrompt('test prompt');

    expect(mockSend).toHaveBeenCalledOnce();
    const [cmd] = mockSend.mock.calls[0];
    expect(cmd.input).toMatchObject({
      guardrailIdentifier: 'my-id',
      guardrailVersion: '3',
      source: 'INPUT',
      content: [{ text: { text: 'test prompt' } }],
    });
  });
});
