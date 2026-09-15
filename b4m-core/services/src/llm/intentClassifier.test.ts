import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ILogger } from '@bike4mind/observability';
import type { ModelInfo } from '@bike4mind/common';
import { IntentClassifierConfigSchema } from '@bike4mind/common';
import type { ApiKeyTable, ICompletionBackend } from '@bike4mind/llm-adapters';
import { classifyIntent, CascadeExhaustedError, type IntentClassifierAdapters } from './intentClassifier';
import { IntentClassifierCache } from './intentClassifier.cache';

// Pulled from the schema so the tests stay in sync with admin defaults - if
// the configured cascade ever changes, the mocked cascade composition tracks
// it without a separate code update.
const SCHEMA_DEFAULTS = IntentClassifierConfigSchema.parse({});
const PRIMARY_MODEL = SCHEMA_DEFAULTS.primaryModel;
const FALLBACK_MODEL_A = SCHEMA_DEFAULTS.fallbackModels[0];
const FALLBACK_MODEL_B = SCHEMA_DEFAULTS.fallbackModels[1];

const silentLogger: ILogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ILogger;

function makeModel(id: string, backend: ModelInfo['backend'] = 'anthropic'): ModelInfo {
  return {
    id,
    backend,
    description: id,
    contextWindow: 100_000,
    capabilities: { textInput: true, textOutput: true },
  } as unknown as ModelInfo;
}

interface MockBackendOptions {
  /** Chunks emitted to the streaming callback in order. */
  chunks?: string[];
  /** Single full text response. Mutually exclusive with `chunks`. */
  text?: string;
  /** If set, throw this error before invoking the callback. */
  throwBefore?: Error;
  /** If set, throw this error AFTER the callback emits (simulates post-stream failure). */
  throwAfter?: Error;
  /** Reported by completionInfo.responseFormatMode. */
  responseFormatMode?: 'native' | 'tool_use' | 'best-effort';
  /** When true, emit chunks one at a time so the early-exit detector can fire mid-stream. */
  honorAbort?: boolean;
}

function makeBackend(opts: MockBackendOptions): {
  backend: ICompletionBackend;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (_model: string, _messages: unknown, options: any, callback: any) => {
    if (opts.throwBefore) throw opts.throwBefore;
    const completionInfo = opts.responseFormatMode ? { responseFormatMode: opts.responseFormatMode } : undefined;
    if (opts.chunks) {
      for (const chunk of opts.chunks) {
        if (opts.honorAbort && options?.abortSignal?.aborted) return;
        await callback([chunk], completionInfo);
        // Tick so the controller.abort() from the callback can settle before the next chunk.
        await new Promise(r => setImmediate(r));
      }
    } else {
      await callback([opts.text ?? ''], completionInfo);
    }
    if (opts.throwAfter) throw opts.throwAfter;
  });

  const backend = {
    currentModel: 'mock',
    complete: spy,
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn(async () => []),
  } as unknown as ICompletionBackend;

  return { backend, spy };
}

function makeAdapters(
  backends: Record<string, ICompletionBackend>,
  overrides: Partial<IntentClassifierAdapters> = {}
): IntentClassifierAdapters {
  const apiKeyTable: ApiKeyTable = { anthropic: 'k-anthropic', gemini: 'k-gemini', openai: 'k-openai' };
  const availableModels = Object.keys(backends).map(id => {
    if (id.startsWith('gemini')) return makeModel(id, 'gemini');
    if (id.startsWith('gpt')) return makeModel(id, 'openai');
    return makeModel(id, 'anthropic');
  });

  return {
    apiKeyTable,
    availableModels,
    logger: silentLogger,
    cache: new IntentClassifierCache(),
    config: {
      enabled: true,
      shadowMode: true,
      primaryModel: Object.keys(backends)[0],
      fallbackModels: Object.keys(backends).slice(1),
    },
    ...overrides,
    // The classifier asks for `getLlmByModel(apiKeyTable, { modelInfo })` - to
    // intercept that without mocking the whole adapters module, we route the
    // cascade explicitly via `resolveCascade` and patch in the backend factory
    // by overriding getLlmByModel through a module-level vi.mock below.
  };
}

// We mock @bike4mind/llm-adapters so classifyIntent's getLlmByModel call returns
// our mock backends. The mock holds a registry of model id -> backend so each
// test sets exactly the cascade it wants to exercise.
const backendRegistry = new Map<string, ICompletionBackend | null>();

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getLlmByModel: (_apiKeys: ApiKeyTable, { modelInfo }: { modelInfo?: ModelInfo }): ICompletionBackend | null => {
      if (!modelInfo) return null;
      return backendRegistry.get(modelInfo.id) ?? null;
    },
  };
});

function registerCascade(entries: Array<[string, ICompletionBackend | null]>): void {
  backendRegistry.clear();
  for (const [id, backend] of entries) backendRegistry.set(id, backend);
}

beforeEach(() => {
  backendRegistry.clear();
});

const wellFormedJson = JSON.stringify({
  useAgent: true,
  confidence: 0.9,
  reason: 'Needs current data lookup.',
  signals: ['needs_current_data'],
});

describe('classifyIntent — primary path', () => {
  it('returns the parsed decision from the primary backend', async () => {
    const { backend, spy } = makeBackend({ text: wellFormedJson, responseFormatMode: 'tool_use' });
    registerCascade([[PRIMARY_MODEL, backend]]);

    const decision = await classifyIntent(
      { userId: 'u1', message: 'What is NVDA stock price?' },
      makeAdapters({ [PRIMARY_MODEL]: backend })
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(decision.useAgent).toBe(true);
    expect(decision.confidence).toBe(0.9);
    expect(decision.classifierModel).toBe(PRIMARY_MODEL);
    expect(decision.cacheHit).toBe(false);
    expect(decision.responseFormatMode).toBe('tool_use');
  });

  it('serves repeated calls from the per-user cache', async () => {
    const { backend, spy } = makeBackend({ text: wellFormedJson });
    registerCascade([[PRIMARY_MODEL, backend]]);
    const adapters = makeAdapters({ [PRIMARY_MODEL]: backend });

    const first = await classifyIntent({ userId: 'u1', message: 'same query' }, adapters);
    const second = await classifyIntent({ userId: 'u1', message: 'same query' }, adapters);

    expect(spy).toHaveBeenCalledOnce();
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.useAgent).toBe(first.useAgent);
  });

  it('clears stale responseFormatMode and earlyExited on cache hits', async () => {
    const { backend } = makeBackend({ text: wellFormedJson, responseFormatMode: 'best-effort' });
    registerCascade([[PRIMARY_MODEL, backend]]);
    const adapters = makeAdapters({ [PRIMARY_MODEL]: backend });

    const first = await classifyIntent({ userId: 'u1', message: 'same query' }, adapters);
    const second = await classifyIntent({ userId: 'u1', message: 'same query' }, adapters);

    // Sanity: the underlying call surfaced best-effort telemetry.
    expect(first.responseFormatMode).toBe('best-effort');

    // The cache-served response must NOT propagate those telemetry fields -
    // they describe the original call, not the cached response, and would
    // poison "% best-effort" / "% early-exited" dashboards.
    expect(second.cacheHit).toBe(true);
    expect(second.responseFormatMode).toBeUndefined();
    expect(second.earlyExited).toBe(false);
  });

  it('treats the same message with different context flags as distinct cache slots', async () => {
    const { backend, spy } = makeBackend({ text: wellFormedJson });
    registerCascade([[PRIMARY_MODEL, backend]]);
    const adapters = makeAdapters({ [PRIMARY_MODEL]: backend });

    await classifyIntent({ userId: 'u1', message: 'analyze this' }, adapters);
    await classifyIntent({ userId: 'u1', message: 'analyze this', hasFileAttachments: true }, adapters);
    await classifyIntent({ userId: 'u1', message: 'analyze this', hasAgentMention: true }, adapters);

    // Three distinct cache slots -> three underlying calls.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not collide cache entries across users', async () => {
    const { backend, spy } = makeBackend({ text: wellFormedJson });
    registerCascade([[PRIMARY_MODEL, backend]]);
    const adapters = makeAdapters({ [PRIMARY_MODEL]: backend });

    await classifyIntent({ userId: 'alice', message: 'same query' }, adapters);
    await classifyIntent({ userId: 'bob', message: 'same query' }, adapters);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('classifyIntent — fallback cascade', () => {
  it('falls through to gemini when the anthropic backend has no api key', async () => {
    const { backend: gemini, spy: geminiSpy } = makeBackend({ text: wellFormedJson });
    // Anthropic backend null in registry -> cascade skips to Gemini.
    registerCascade([
      [PRIMARY_MODEL, null],
      [FALLBACK_MODEL_A, gemini],
    ]);

    const adapters: IntentClassifierAdapters = {
      apiKeyTable: { gemini: 'k-gemini' },
      availableModels: [makeModel(PRIMARY_MODEL, 'anthropic'), makeModel(FALLBACK_MODEL_A, 'gemini')],
      logger: silentLogger,
      cache: new IntentClassifierCache(),
      config: {
        enabled: true,
        shadowMode: true,
        primaryModel: PRIMARY_MODEL,
        fallbackModels: [FALLBACK_MODEL_A],
      },
    };

    const decision = await classifyIntent({ userId: 'u1', message: 'hello' }, adapters);

    expect(geminiSpy).toHaveBeenCalledOnce();
    expect(decision.classifierModel).toBe(FALLBACK_MODEL_A);
  });

  it('falls through anthropic → gemini → openai when each upstream throws', async () => {
    const { backend: anthro } = makeBackend({ throwBefore: new Error('anthropic 503') });
    const { backend: gemini } = makeBackend({ throwBefore: new Error('gemini boom') });
    const { backend: openai } = makeBackend({ text: wellFormedJson });

    registerCascade([
      [PRIMARY_MODEL, anthro],
      [FALLBACK_MODEL_A, gemini],
      [FALLBACK_MODEL_B, openai],
    ]);

    const adapters = makeAdapters({
      [PRIMARY_MODEL]: anthro,
      [FALLBACK_MODEL_A]: gemini,
      [FALLBACK_MODEL_B]: openai,
    });

    const decision = await classifyIntent({ userId: 'u1', message: 'what is the weather' }, adapters);

    expect(decision.classifierModel).toBe(FALLBACK_MODEL_B);
    expect(decision.useAgent).toBe(true);
  });

  it('throws CascadeExhaustedError when every backend fails', async () => {
    const { backend: a } = makeBackend({ throwBefore: new Error('a') });
    const { backend: b } = makeBackend({ throwBefore: new Error('b') });
    registerCascade([
      [PRIMARY_MODEL, a],
      [FALLBACK_MODEL_A, b],
    ]);

    const adapters = makeAdapters({
      [PRIMARY_MODEL]: a,
      [FALLBACK_MODEL_A]: b,
    });

    await expect(classifyIntent({ userId: 'u1', message: 'q' }, adapters)).rejects.toBeInstanceOf(
      CascadeExhaustedError
    );
  });
});

describe('classifyIntent — best-effort retry', () => {
  it('retries once with a stricter prompt when best-effort validation fails', async () => {
    let callCount = 0;
    const spy = vi.fn(async (_m: string, _msgs: unknown, _o: any, cb: any) => {
      callCount += 1;
      const text = callCount === 1 ? 'oops not json' : wellFormedJson;
      await cb([text], { responseFormatMode: 'best-effort' });
    });
    const backend = {
      currentModel: 'mock',
      complete: spy,
      pushToolMessages: vi.fn(),
      getModelInfo: vi.fn(async () => []),
    } as unknown as ICompletionBackend;

    registerCascade([[FALLBACK_MODEL_A, backend]]);

    const adapters: IntentClassifierAdapters = {
      apiKeyTable: { gemini: 'k' },
      availableModels: [makeModel(FALLBACK_MODEL_A, 'gemini')],
      logger: silentLogger,
      cache: new IntentClassifierCache(),
      config: {
        enabled: true,
        shadowMode: true,
        primaryModel: FALLBACK_MODEL_A,
        fallbackModels: [],
      },
    };

    const decision = await classifyIntent({ userId: 'u1', message: 'x' }, adapters);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(decision.useAgent).toBe(true);
  });
});

describe('classifyIntent — streaming early-exit', () => {
  it('recovers the full decision when later fields stream in within the grace window', async () => {
    // The trailing fields arrive on the very next chunk - the fast-path check
    // (`extractJSON(accumulated)` succeeds) aborts immediately without
    // waiting for the grace deadline, AND we keep confidence/reason/signals.
    const chunks = [
      '{"useAgent": true, ',
      '"confidence": 0.85, "reason": "needs lookup", "signals": ["needs_web_search"]}',
    ];
    const { backend, spy } = makeBackend({ chunks, honorAbort: true });
    registerCascade([[PRIMARY_MODEL, backend]]);

    const decision = await classifyIntent({ userId: 'u1', message: 'x' }, makeAdapters({ [PRIMARY_MODEL]: backend }));

    expect(spy).toHaveBeenCalledOnce();
    expect(decision.useAgent).toBe(true);
    expect(decision.earlyExited).toBe(true);
    // Grace window let the trailing fields stream in - we should see the
    // real values, not the partial-parse defaults.
    expect(decision.confidence).toBe(0.85);
    expect(decision.reason).toBe('needs lookup');
    expect(decision.signals).toEqual(['needs_web_search']);
  });

  it('falls back to partial-parse defaults when later fields never arrive', async () => {
    // Only the first chunk arrives, then the backend hangs. The grace timer
    // expires and we abort with whatever we have - useAgent + defaults.
    const spy = vi.fn(async (_m: string, _msgs: unknown, options: any, callback: any) => {
      await callback(['{"useAgent": true, '], { responseFormatMode: 'tool_use' });
      // Hang until aborted - simulates a backend that emits useAgent then stalls.
      await new Promise<void>(resolve => {
        if (options?.abortSignal?.aborted) return resolve();
        options?.abortSignal?.addEventListener?.('abort', () => resolve(), { once: true });
      });
    });
    const backend = {
      currentModel: 'mock',
      complete: spy,
      pushToolMessages: vi.fn(),
      getModelInfo: vi.fn(async () => []),
    } as unknown as ICompletionBackend;
    registerCascade([[PRIMARY_MODEL, backend]]);

    const decision = await classifyIntent({ userId: 'u1', message: 'x' }, makeAdapters({ [PRIMARY_MODEL]: backend }));

    expect(decision.useAgent).toBe(true);
    expect(decision.earlyExited).toBe(true);
    // Partial-parse defaults from extractPartialDecision().
    expect(decision.confidence).toBe(0.5);
    expect(decision.reason).toBe('streaming early-exit');
    expect(decision.signals).toEqual([]);
  });

  it('keeps the legacy assertion: aborts on `useAgent` resolution', async () => {
    const chunks = [
      '{"useAgent": true, ',
      '"confidence": 0.85, "reason": "needs lookup", "signals": ["needs_web_search"]}',
    ];
    const { backend, spy } = makeBackend({ chunks, honorAbort: true });
    registerCascade([[PRIMARY_MODEL, backend]]);

    const decision = await classifyIntent({ userId: 'u1', message: 'x' }, makeAdapters({ [PRIMARY_MODEL]: backend }));

    expect(spy).toHaveBeenCalledOnce();
    expect(decision.useAgent).toBe(true);
    expect(decision.earlyExited).toBe(true);
    // confidence/reason may be defaults if the abort landed before later fields streamed
    expect(typeof decision.confidence).toBe('number');
  });
});

describe('classifyIntent — config + input validation', () => {
  it('throws when the cascade is empty', async () => {
    await expect(
      classifyIntent(
        { userId: 'u1', message: 'x' },
        {
          apiKeyTable: {},
          availableModels: [],
          logger: silentLogger,
          config: { enabled: true, shadowMode: true, primaryModel: '', fallbackModels: [] },
          resolveCascade: () => [],
        }
      )
    ).rejects.toThrow(/cascade is empty/);
  });
});
