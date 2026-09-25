import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { PromptMeta } from '@bike4mind/common';
import { buildContextBreakdown } from './contextBreakdown';

const tokensBySource = {
  systemPrompts: 4000,
  conversationHistory: 1200,
  mementos: 300,
  fabFiles: 500,
  urlContent: 100,
  toolSchemas: 900,
  userPrompt: 40,
};

const fullPromptMeta = (): PromptMeta => ({
  generatedAt: '2026-09-16T10:00:00.000Z',
  model: {
    name: 'claude-opus-4-8',
    backend: 'bedrock',
    contextWindow: 200000,
    maxTokens: 64000,
    parameters: { maxTokens: 8192 },
  },
  tokenUsage: {
    inputTokens: 7040,
    outputTokens: 512,
    cacheReadInputTokens: 6000,
    cacheCreationInputTokens: 2000,
    settledBasis: 'provider',
  },
  retrieval: {
    attempted: true,
    outcome: 'ok',
    mode: 'forced',
    surfaces: ['forced'],
    dataLakeTags: ['northwind'],
    injected: { chunks: 3, chars: 900 },
  },
  offeredTools: ['search_knowledge_base', 'web_fetch'],
  functionCalls: [
    {
      name: 'search_knowledge_base',
      success: true,
      executionTime: 120,
      parameters: { query: 'SECRET-PARAM' },
      returnValue: 'SECRET-RETURN',
    },
    { name: 'search_knowledge_base', success: false, executionTime: 80, error: 'SECRET-ERROR' },
    { name: 'delegate_to_agent', success: true },
  ],
  context: {
    systemPrompt: 'SECRET-SYSTEM',
    userPrompt: 'SECRET-USER',
    tokensBySource,
    systemPromptDetails: [
      { source: 'admin', name: 'artifact_emission', tokenCount: 2822, wasIncluded: true },
      { source: 'hardcoded', name: 'date_time_context', tokenCount: 60, wasIncluded: true },
      { source: 'hardcoded', name: 'image_prompt', tokenCount: 38, wasIncluded: true },
      {
        source: 'session',
        name: 'session_prompt',
        tokenCount: 4744,
        wasIncluded: false,
        exclusionReason: 'token_limit',
      },
    ],
  },
});

describe('buildContextBreakdown', () => {
  it('sorts layers into delivery order and keeps their exclusion reasons', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    expect(breakdown.layers.map(layer => layer.name)).toEqual([
      'image_prompt',
      'date_time_context',
      'artifact_emission',
      'session_prompt',
    ]);
    expect(breakdown.layers.at(-1)).toEqual({
      source: 'session',
      name: 'session_prompt',
      tokenCount: 4744,
      wasIncluded: false,
      exclusionReason: 'token_limit',
    });
  });

  it('fingerprints the included layers in delivery order, first 12 hex of sha256', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    const expected = createHash('sha256')
      .update('hardcoded:image_prompt:38|hardcoded:date_time_context:60|admin:artifact_emission:2822')
      .digest('hex')
      .slice(0, 12);
    expect(breakdown.promptFingerprint).toBe(expected);
    expect(breakdown.promptFingerprint).toHaveLength(12);
  });

  it('changes the fingerprint when a layer changes and holds it when an excluded layer does', () => {
    const base = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    const retokened = fullPromptMeta();
    retokened.context!.systemPromptDetails![0].tokenCount = 2823;
    expect(buildContextBreakdown(retokened, { questId: 'quest-1' }).promptFingerprint).not.toBe(base.promptFingerprint);

    const excludedChanged = fullPromptMeta();
    excludedChanged.context!.systemPromptDetails![3].tokenCount = 9999;
    expect(buildContextBreakdown(excludedChanged, { questId: 'quest-1' }).promptFingerprint).toBe(
      base.promptFingerprint
    );
  });

  it('derives free space from the window, the input and the output reservation', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    expect(breakdown.window).toEqual({
      contextWindow: 200000,
      inputTokens: 7040,
      outputTokens: 512,
      maxOutputTokens: 8192,
      freeSpace: 200000 - 7040 - 8192,
    });
  });

  it('reports a negative free space rather than clamping an overflowed turn', () => {
    const overflowed = fullPromptMeta();
    overflowed.tokenUsage!.inputTokens = 199000;

    expect(buildContextBreakdown(overflowed, { questId: 'quest-1' }).window.freeSpace).toBe(200000 - 199000 - 8192);
  });

  it('leaves free space null when the model window is unknown', () => {
    const noWindow = fullPromptMeta();
    delete noWindow.model!.contextWindow;

    expect(buildContextBreakdown(noWindow, { questId: 'quest-1' }).window.freeSpace).toBeNull();
  });

  it('sums the included layers for the system-prompt category and keeps the residual beside it', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    expect(breakdown.categories).toEqual({
      systemPrompt: 2822 + 60 + 38,
      systemPromptBilled: 4000,
      toolDefinitions: 900,
      attachedFiles: 500,
      conversationHistory: 1200,
      memory: 300,
      urlContent: 100,
      userMessage: 40,
      // No bucket recorded on this turn, so the lake volume is UNKNOWN rather than zero.
      lakeRetrieval: null,
    });
  });

  it('leaves a pre-change turn whole: unknown lake volume, layers still counted in the system sum', () => {
    const preChange = fullPromptMeta();
    preChange.context!.systemPromptDetails!.push(
      { source: 'session', name: 'knowledge_retrieval', tokenCount: 300, wasIncluded: true },
      { source: 'session', name: 'lake_memory', tokenCount: 40, wasIncluded: true }
    );

    const breakdown = buildContextBreakdown(preChange, { questId: 'quest-1' });

    // Nothing recorded a lake bucket on this turn, so it reads as unknown and the lake layers stay
    // inside the layer sum they were always part of - byte-identical to how they rendered before.
    expect(breakdown.categories.lakeRetrieval).toBeNull();
    expect(breakdown.categories.systemPrompt).toBe(2822 + 60 + 38 + 300 + 40);
    expect(breakdown.categories.systemPromptBilled).toBe(4000);
  });

  it('promotes a recorded lake bucket out of the system-prompt layer sum', () => {
    const withLake = fullPromptMeta();
    withLake.context!.tokensBySource = { ...tokensBySource, systemPrompts: 3660, lakeRetrieval: 340 };
    withLake.context!.systemPromptDetails!.push(
      { source: 'session', name: 'knowledge_retrieval', tokenCount: 300, wasIncluded: true },
      { source: 'session', name: 'lake_memory', tokenCount: 40, wasIncluded: true }
    );

    const breakdown = buildContextBreakdown(withLake, { questId: 'quest-1' });

    expect(breakdown.categories.lakeRetrieval).toBe(340);
    // The whole included-layer sum less the 340 now reported as lake: the two rows must not overlap.
    expect(breakdown.categories.systemPrompt).toBe(2822 + 60 + 38 + 340 - 340);
    // The residual the write site already netted the lake tokens out of.
    expect(breakdown.categories.systemPromptBilled).toBe(3660);
  });

  it('counts tool invocations per name and marks tools the model was never offered', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    expect(breakdown.tools).toEqual([
      {
        name: 'search_knowledge_base',
        offered: true,
        invocations: 2,
        successes: 1,
        failures: 1,
        durationMs: 200,
      },
      { name: 'web_fetch', offered: true, invocations: 0, successes: 0, failures: 0 },
      { name: 'delegate_to_agent', offered: false, invocations: 1, successes: 1, failures: 0 },
    ]);
  });

  it('passes the retrieval verdict through verbatim', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    expect(breakdown.retrieval).toEqual(fullPromptMeta().retrieval);
  });

  it('reports cache tokens and the read share of the cacheable total', () => {
    const breakdown = buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' });

    expect(breakdown.cache).toEqual({
      readTokens: 6000,
      writeTokens: 2000,
      hitRate: 0.75,
      settledBasis: 'provider',
    });
  });

  it('omits every owner-only and content-bearing field', () => {
    const serialized = JSON.stringify(buildContextBreakdown(fullPromptMeta(), { questId: 'quest-1' }));

    expect(serialized).not.toContain('SECRET-SYSTEM');
    expect(serialized).not.toContain('SECRET-USER');
    expect(serialized).not.toContain('SECRET-RETURN');
    expect(serialized).not.toContain('SECRET-ERROR');
    expect(serialized).not.toContain('SECRET-PARAM');
    expect(serialized).not.toContain('returnValue');
    expect(serialized).not.toContain('parameters');
    expect(serialized).not.toContain('"userPrompt"');
    expect(serialized).not.toContain('systemPromptSources');
    expect(serialized).not.toContain('contextTelemetry');
  });

  it('drops contextTelemetry even when the quest carries it', () => {
    const withTelemetry = fullPromptMeta();
    // any: a full ContextTelemetry fixture is irrelevant here - the assertion is that the key never
    // survives the projection, whatever it holds.
    (withTelemetry as any).contextTelemetry = { schemaVersion: '1.2', anonymousSessionId: { hash: 'SECRET-HASH' } };

    const serialized = JSON.stringify(buildContextBreakdown(withTelemetry, { questId: 'quest-1' }));
    expect(serialized).not.toContain('SECRET-HASH');
  });

  it('returns a zeroed but complete breakdown for a quest recorded before any of this existed', () => {
    const breakdown = buildContextBreakdown(undefined, { questId: 'quest-old' });

    expect(breakdown).toEqual({
      questId: 'quest-old',
      capturedAt: null,
      model: { id: null, backend: null },
      categories: {
        systemPrompt: 0,
        systemPromptBilled: 0,
        toolDefinitions: 0,
        attachedFiles: 0,
        conversationHistory: 0,
        memory: 0,
        urlContent: 0,
        userMessage: 0,
        lakeRetrieval: null,
      },
      layers: [],
      tools: [],
      retrieval: null,
      cache: { readTokens: 0, writeTokens: 0, hitRate: 0, settledBasis: null },
      window: { contextWindow: null, inputTokens: 0, outputTokens: 0, maxOutputTokens: null, freeSpace: null },
      promptFingerprint: '',
    });
  });

  it('keeps the layer rows when tokensBySource is missing', () => {
    const noBuckets = fullPromptMeta();
    delete noBuckets.context!.tokensBySource;

    const breakdown = buildContextBreakdown(noBuckets, { questId: 'quest-1' });
    expect(breakdown.layers).toHaveLength(4);
    expect(breakdown.categories.systemPrompt).toBe(2822 + 60 + 38);
    expect(breakdown.categories.systemPromptBilled).toBe(0);
  });

  it('prefers the recorded reservation over the requested value when both are present', () => {
    const withReservation = fullPromptMeta();
    withReservation.context!.contextWindowUsage = {
      contextLimit: 200000,
      maxOutputTokens: 6000,
      safeMaxInputTokens: 194000,
      actualInputTokens: 7040,
      bufferTokens: 0,
      utilizationPercentage: 3.5,
    };

    const breakdown = buildContextBreakdown(withReservation, { questId: 'quest-1' });
    expect(breakdown.window.maxOutputTokens).toBe(6000);
    expect(breakdown.window.freeSpace).toBe(200000 - 7040 - 6000);
  });

  it('does not fall back to the model catalog ceiling when neither reservation is recorded', () => {
    const catalogOnly = fullPromptMeta();
    delete catalogOnly.context!.contextWindowUsage;
    delete catalogOnly.model!.parameters;

    const breakdown = buildContextBreakdown(catalogOnly, { questId: 'quest-1' });
    expect(breakdown.window.maxOutputTokens).toBeNull();
    expect(breakdown.window.freeSpace).toBeNull();
  });
});
