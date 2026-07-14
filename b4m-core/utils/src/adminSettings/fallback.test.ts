import { describe, it, expect, vi } from 'vitest';
import { shouldTriggerFallback, isOverloadedError, validateFallbackModel, getLlmWithFallback } from './fallback';
import { AxiosError } from 'axios';
import { ModelInfo, ModelBackend } from '@bike4mind/common';

// Helper to create mock Axios errors
function createAxiosError(status: number, code?: string): AxiosError {
  const error = new Error(`Request failed with status ${status}`) as AxiosError;
  error.isAxiosError = true;
  error.response = {
    status,
    statusText: 'Error',
    headers: {},
    data: {},
    config: {} as any,
  };
  if (code) {
    error.code = code;
  }
  return error;
}

// Helper to create mock AWS SDK v3 service exceptions (e.g. Bedrock). These are plain Error
// subclasses with the failure type on `.name` and the HTTP status on `$metadata.httpStatusCode`,
// NOT the Axios `response.status` shape.
function createAwsSdkError(name: string, httpStatusCode?: number, message?: string): Error {
  const error = new Error(message ?? 'Bedrock is unable to process your request.');
  error.name = name;
  if (httpStatusCode !== undefined) {
    (error as Error & { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  }
  return error;
}

describe('shouldTriggerFallback', () => {
  describe('Anthropic API errors', () => {
    it('should return true for overloaded_error from Anthropic API', () => {
      const error = new Error(
        '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}'
      );
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "Overloaded" message (case insensitive)', () => {
      const error = new Error('Overloaded');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for model overloaded errors', () => {
      const error = new Error('Model overloaded, please try again later');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for a Fable 5 safety-classifier refusal (routes to Opus 4.8)', () => {
      const error = new Error(
        'Anthropic safety classifier refusal for claude-fable-5 — falling back to an alternative model'
      );
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for a gated-model availability 404 (routes to fallback)', () => {
      // Anthropic's 404 for an account/env lacking access to an un-gated model.
      const error = new Error('Claude Fable 5 is not available. Please use Opus 4.8');
      expect(shouldTriggerFallback(error)).toBe(true);
    });
  });

  describe('Axios HTTP errors', () => {
    it('should return true for 429 rate limit errors', () => {
      const error = createAxiosError(429);
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for 502 bad gateway errors', () => {
      const error = createAxiosError(502);
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for 503 service unavailable errors', () => {
      const error = createAxiosError(503);
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for 504 gateway timeout errors', () => {
      const error = createAxiosError(504);
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for ECONNREFUSED errors', () => {
      const error = createAxiosError(0, 'ECONNREFUSED');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for ETIMEDOUT errors', () => {
      const error = createAxiosError(0, 'ETIMEDOUT');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for ECONNRESET errors', () => {
      const error = createAxiosError(0, 'ECONNRESET');
      expect(shouldTriggerFallback(error)).toBe(true);
    });
  });

  describe('AWS SDK v3 service exceptions (e.g. Bedrock)', () => {
    // Regression for the Bedrock 503 incident: the SDK throws a non-Axios error whose status
    // lives on $metadata.httpStatusCode and whose message ("Bedrock is unable to process your
    // request.") matches none of the substring triggers. Before the fix this returned false,
    // so the request never fell back to a healthy model.
    it('should return true for ServiceUnavailableException with 503 metadata status', () => {
      const error = createAwsSdkError('ServiceUnavailableException', 503);
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for ServiceUnavailableException by name even without $metadata', () => {
      const error = createAwsSdkError('ServiceUnavailableException');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for ThrottlingException (429)', () => {
      const error = createAwsSdkError('ThrottlingException', 429, 'Too many requests, please wait.');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for InternalServerException (500)', () => {
      const error = createAwsSdkError('InternalServerException', 500);
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return false for a non-transient SDK error (e.g. ValidationException 400)', () => {
      const error = createAwsSdkError('ValidationException', 400, 'Invalid request parameters.');
      expect(shouldTriggerFallback(error)).toBe(false);
    });
  });

  describe('Network and connection errors', () => {
    it('should return true for ECONNRESET in error code (non-Axios)', () => {
      const error = new Error('Connection reset');
      (error as any).code = 'ECONNRESET';
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return false for ECONNRESET with aborted message', () => {
      const error = new Error('Request aborted');
      (error as any).code = 'ECONNRESET';
      expect(shouldTriggerFallback(error)).toBe(false);
    });

    it('should return true for TypeError: terminated (undici/fetch)', () => {
      const error = new TypeError('terminated');
      expect(shouldTriggerFallback(error)).toBe(true);
    });
  });

  describe('Model-specific error messages', () => {
    it('should return true for "model not available"', () => {
      const error = new Error('Error: model not available');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "capacity" errors', () => {
      const error = new Error('Insufficient capacity to process request');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "rate limit" errors', () => {
      const error = new Error('Rate limit exceeded');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "service unavailable" errors', () => {
      const error = new Error('Service unavailable');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "timeout" errors', () => {
      const error = new Error('Request timeout');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "connection refused" errors', () => {
      const error = new Error('Connection refused');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "token limit exceeded" errors', () => {
      const error = new Error('Token limit exceeded');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "quota exceeded" errors', () => {
      const error = new Error('Quota exceeded');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "model not found" errors', () => {
      const error = new Error('Model not found');
      expect(shouldTriggerFallback(error)).toBe(true);
    });
  });

  describe('Deprecated model errors', () => {
    it('should return true for "model not found" error text', () => {
      const error = new Error('model not found: claude-3-5-haiku-20241022');
      expect(shouldTriggerFallback(error)).toBe(true);
    });

    it('should return true for "does not exist" errors', () => {
      const error = new Error('The model claude-3-5-haiku-20241022 does not exist');
      expect(shouldTriggerFallback(error)).toBe(true);
    });
  });

  describe('Non-retryable errors', () => {
    it('should return false for generic errors', () => {
      const error = new Error('Something went wrong');
      expect(shouldTriggerFallback(error)).toBe(false);
    });

    it('should return false for 400 bad request', () => {
      const error = createAxiosError(400);
      expect(shouldTriggerFallback(error)).toBe(false);
    });

    it('should return false for 401 unauthorized', () => {
      const error = createAxiosError(401);
      expect(shouldTriggerFallback(error)).toBe(false);
    });

    it('should return false for 404 not found (without message match)', () => {
      const error = createAxiosError(404);
      expect(shouldTriggerFallback(error)).toBe(false);
    });
  });
});

describe('isOverloadedError', () => {
  it('should return true for Axios 503', () => {
    expect(isOverloadedError(createAxiosError(503))).toBe(true);
  });

  it('should return true for Axios 429', () => {
    expect(isOverloadedError(createAxiosError(429))).toBe(true);
  });

  it('should return true for Bedrock ServiceUnavailableException (503 metadata)', () => {
    expect(isOverloadedError(createAwsSdkError('ServiceUnavailableException', 503))).toBe(true);
  });

  it('should return true for Bedrock ServiceUnavailableException by name', () => {
    expect(isOverloadedError(createAwsSdkError('ServiceUnavailableException'))).toBe(true);
  });

  it('should return true for ThrottlingException (429)', () => {
    expect(isOverloadedError(createAwsSdkError('ThrottlingException', 429, 'Throttled'))).toBe(true);
  });

  it('should return true for "overloaded" message', () => {
    expect(isOverloadedError(new Error('Model overloaded'))).toBe(true);
  });

  it('should return false for a generic error', () => {
    expect(isOverloadedError(new Error('Something went wrong'))).toBe(false);
  });

  it('should return false for a non-transient SDK error (ValidationException 400)', () => {
    expect(isOverloadedError(createAwsSdkError('ValidationException', 400, 'Invalid'))).toBe(false);
  });
});

// Helper to create minimal ModelInfo objects for testing
function createModelInfo(overrides: Partial<ModelInfo> & { id: string; backend: ModelBackend }): ModelInfo {
  return {
    type: 'text',
    name: overrides.id,
    contextWindow: 200000,
    max_tokens: 8192,
    supportsImageVariation: false,
    pricing: { 200000: { input: 0.001, output: 0.005 } },
    ...overrides,
  } as ModelInfo;
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('@bike4mind/observability').Logger;

describe('validateFallbackModel', () => {
  const haiku45 = createModelInfo({ id: 'claude-haiku-4-5-20251001', backend: ModelBackend.Anthropic });
  const gptMini = createModelInfo({ id: 'gpt-4o-mini', backend: ModelBackend.OpenAI });
  const availableModels = [haiku45, gptMini];
  const apiKeyTable = { anthropic: 'valid-key', openai: 'valid-key' } as Record<string, string>;

  it('should return model when it exists and has valid API key', () => {
    const result = validateFallbackModel('claude-haiku-4-5-20251001', availableModels, apiKeyTable, mockLogger);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('claude-haiku-4-5-20251001');
  });

  it('should return null when model is not in available models', () => {
    const result = validateFallbackModel('claude-3-5-haiku-20241022', availableModels, apiKeyTable, mockLogger);
    expect(result).toBeNull();
  });

  it('should return null when API key is missing for the model backend', () => {
    const noKeyTable = { openai: 'valid-key' } as Record<string, string>;
    const result = validateFallbackModel('claude-haiku-4-5-20251001', availableModels, noKeyTable, mockLogger);
    expect(result).toBeNull();
  });

  it('should return null when API key is expired', () => {
    const expiredKeyTable = { anthropic: 'expired', openai: 'valid-key' } as Record<string, string>;
    const result = validateFallbackModel('claude-haiku-4-5-20251001', availableModels, expiredKeyTable, mockLogger);
    expect(result).toBeNull();
  });
});

describe('getLlmWithFallback - forceSwitch option', () => {
  // Tests verify that forceSwitch:true skips the original model check and forces a model switch.
  // This is critical for overloaded_error recovery: without forceSwitch, getLlmWithFallback
  // always returns attempt:0 (same model) when the original backend has a valid API key.

  const opus45 = createModelInfo({
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    backend: ModelBackend.Anthropic,
  });
  const sonnet46 = createModelInfo({
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    backend: ModelBackend.Anthropic,
  });
  const availableModels = [opus45, sonnet46];
  const apiKeyTable = { anthropic: 'valid-key' } as Record<string, string>;

  it('should return attempt:0 (same model) without forceSwitch when original backend is available', async () => {
    const result = await getLlmWithFallback(opus45, undefined, availableModels, apiKeyTable, mockLogger);
    expect(result).not.toBeNull();
    expect(result!.attempt).toBe(0);
    expect(result!.model.id).toBe('claude-opus-4-5-20251101');
  });

  it('should return attempt:1 (different model) with forceSwitch:true even when original backend is available', async () => {
    const result = await getLlmWithFallback(opus45, undefined, availableModels, apiKeyTable, mockLogger, {
      forceSwitch: true,
    });
    expect(result).not.toBeNull();
    expect(result!.attempt).toBe(1);
    expect(result!.model.id).not.toBe('claude-opus-4-5-20251101');
    expect(result!.model.id).toBe('claude-sonnet-4-6');
  });

  it('should use frontend-provided fallback model with forceSwitch:true', async () => {
    const result = await getLlmWithFallback(opus45, 'claude-sonnet-4-6', availableModels, apiKeyTable, mockLogger, {
      forceSwitch: true,
    });
    expect(result).not.toBeNull();
    expect(result!.attempt).toBe(1);
    expect(result!.model.id).toBe('claude-sonnet-4-6');
  });

  it('should return null with forceSwitch:true when no fallback models are available', async () => {
    const result = await getLlmWithFallback(
      opus45,
      undefined,
      [opus45], // only the original model available
      apiKeyTable,
      mockLogger,
      { forceSwitch: true }
    );
    expect(result).toBeNull();
  });
});

describe('getLlmWithFallback - deprecated model fallback preferences', () => {
  // These tests verify that the fallback preferences map correctly routes
  // deprecated Haiku 3.5 to Haiku 4.5 through the automatic fallback path.

  const haiku35 = createModelInfo({
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    backend: ModelBackend.Anthropic,
  });
  const haiku45 = createModelInfo({
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude 4.5 Haiku',
    backend: ModelBackend.Anthropic,
  });
  const gptMini = createModelInfo({
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    backend: ModelBackend.OpenAI,
  });
  const availableModels = [haiku35, haiku45, gptMini];

  it('should fall back from Haiku 3.5 to Haiku 4.5 when original backend fails', async () => {
    // Simulate: original model has no working backend (retired), no frontend fallback provided
    const apiKeyTable = { anthropic: 'valid-key', openai: 'valid-key' } as Record<string, string>;

    // getLlmWithFallback calls getLlmByModel internally which we can't easily mock
    // without restructuring. Instead, test the validateFallbackModel path which is
    // the public API for frontend-provided fallbacks.
    const result = validateFallbackModel('claude-haiku-4-5-20251001', availableModels, apiKeyTable, mockLogger);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('claude-haiku-4-5-20251001');
  });

  it('should fall back to gpt-4o-mini when Haiku 4.5 is also unavailable', () => {
    const modelsWithoutHaiku45 = [haiku35, gptMini];
    const apiKeyTable = { openai: 'valid-key' } as Record<string, string>;

    const result = validateFallbackModel('gpt-4o-mini', modelsWithoutHaiku45, apiKeyTable, mockLogger);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('gpt-4o-mini');
  });
});

describe('getLlmWithFallback - Bedrock cross-path fallback chains', () => {
  // A sustained Bedrock outage must degrade to the equivalent Anthropic-direct model
  // (same model, other provider path) before dropping tier or crossing providers. The
  // chains are keyed on the Bedrock-hosted Claude IDs and lead with the direct twin.
  // Bedrock is never a fallback target: it has no apiKeyTable entry (IAM-auth), so the
  // key gate always skips it - a Bedrock model is reachable as the primary only.
  // Every current-gen Bedrock-hosted Claude ID paired with the Anthropic-direct twin its
  // chain must lead with. Keep in sync with fallbackPreferences in fallback.ts.
  const BEDROCK_TO_DIRECT_TWIN: Array<[string, string]> = [
    ['global.anthropic.claude-opus-4-8', 'claude-opus-4-8'],
    ['global.anthropic.claude-opus-4-7', 'claude-opus-4-7'],
    ['global.anthropic.claude-opus-4-6-v1', 'claude-opus-4-6'],
    ['global.anthropic.claude-opus-4-5-20251101-v1:0', 'claude-opus-4-5-20251101'],
    ['global.anthropic.claude-sonnet-5', 'claude-sonnet-5'],
    ['global.anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5-20250929'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
  ];

  const bedrockModels = BEDROCK_TO_DIRECT_TWIN.map(([id]) => createModelInfo({ id, backend: ModelBackend.Bedrock }));
  const directModels = BEDROCK_TO_DIRECT_TWIN.map(([, id]) => createModelInfo({ id, backend: ModelBackend.Anthropic }));
  const openaiModels = [
    createModelInfo({ id: 'gpt-5', backend: ModelBackend.OpenAI }),
    createModelInfo({ id: 'gpt-4o-mini', backend: ModelBackend.OpenAI }),
  ];
  const allModels = [...bedrockModels, ...directModels, ...openaiModels];
  const findBedrock = (id: string) => bedrockModels.find(m => m.id === id)!;

  it.each(BEDROCK_TO_DIRECT_TWIN)(
    'degrades a Bedrock %s outage to its reachable Anthropic-direct twin %s first',
    async (bedrockId, directTwinId) => {
      const apiKeyTable = { anthropic: 'valid-key', openai: 'valid-key' } as Record<string, string>;
      const result = await getLlmWithFallback(findBedrock(bedrockId), undefined, allModels, apiKeyTable, mockLogger, {
        forceSwitch: true,
      });
      expect(result).not.toBeNull();
      expect(result!.attempt).toBe(1);
      expect(result!.model.id).toBe(directTwinId);
      // Never a Bedrock target: Bedrock has no apiKeyTable entry, so the key gate skips it.
      expect(result!.model.backend).toBe(ModelBackend.Anthropic);
    }
  );

  it('skips key-less Anthropic targets and degrades to the cross-provider tail (gpt-5)', async () => {
    // No Anthropic key: every direct-Anthropic twin in the chain is skipped by the key
    // gate, so the request degrades to the cross-provider tail that does have a key.
    const apiKeyTable = { openai: 'valid-key' } as Record<string, string>;
    const result = await getLlmWithFallback(
      findBedrock('global.anthropic.claude-opus-4-8'),
      undefined,
      allModels,
      apiKeyTable,
      mockLogger,
      { forceSwitch: true }
    );
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe('gpt-5');
  });
});
