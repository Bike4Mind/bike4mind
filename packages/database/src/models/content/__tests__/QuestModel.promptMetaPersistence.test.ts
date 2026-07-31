import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { PromptMetaZodSchema } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

/**
 * The drift this locks down was invisible to every unit test that came before it, because the
 * trap only springs on the real write path. save() and findOneAndUpdate + $set cast differently,
 * and a mocked repository can happily assert a field the real schema strips. So this goes through
 * questRepository.update against a real mongod, and reads the raw collection back.
 */

// Deliberately realistic: every value here is one a writer in the repo actually produces. A
// fixture built from schema-shaped placeholders would pass while production data still failed -
// artifacts[].type is the live example, since parseArtifacts emits 'html', never 'text'.
const FULL_PROMPT_META = {
  model: {
    name: 'claude-opus-5',
    type: 'text',
    backend: 'anthropic',
    contextWindow: 200000,
    maxTokens: 64000,
    canStream: true,
    canThink: true,
    supportsVision: true,
    supportsTools: true,
    supportsImageVariation: false,
    supportsSafetyTolerance: false,
    trainingCutoff: '2025-05',
    parameters: {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      logitBias: { '123': -1 },
      stream: true,
      n: 1,
      quality: 'hd',
      style: 'vivid',
      size: '1024x1024',
      width: 1024,
      height: 1024,
      aspect_ratio: '1:1',
      safety_tolerance: 2,
      prompt_upsampling: false,
      seed: 42,
      output_format: 'png',
      response_format: 'url',
      seconds: 8,
      model: 'sora-2',
    },
  },
  tokenUsage: {
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    actualInputTokens: 110,
    actualOutputTokens: 210,
    actualTotalTokens: 320,
    cacheReadInputTokens: 50,
    estimatedCost: 0.0123,
    creditsUsed: 12,
    settledBasis: 'provider',
  },
  context: {
    attachedFiles: [
      { id: 'f1', name: 'a.pdf', type: 'pdf', size: 10, mimeType: 'application/pdf', lastModified: new Date() },
      { id: 'f2', name: 'b.png', type: 'png', size: 20, mimeType: 'image/png' },
    ],
    knowledgeBaseEntries: ['kb-1'],
    messageHistoryLength: 5,
    requestedHistoryCount: 10,
    totalMessageCount: 20,
    mementoCount: 3,
    mementoIds: ['m-1'],
    tokensBySource: {
      systemPrompts: 1,
      conversationHistory: 2,
      mementos: 3,
      fabFiles: 4,
      urlContent: 5,
      toolSchemas: 6,
      userPrompt: 7,
    },
    systemPromptSources: [{ fileId: 'sp-1', fileName: 'admin.md', source: 'admin', priority: 1, enabled: true }],
    dedupedSystemPrompts: ['sp-1'],
    totalSystemPromptCount: 4,
    duplicateSystemPromptCount: 1,
    sessionFileIds: ['sess-1'],
    messageFileIds: ['msg-1'],
    globalSystemFileIds: ['glob-1'],
    userSystemFileIds: ['user-1'],
    projectSystemFileIds: ['proj-1'],
    contextWindowUsage: {
      contextLimit: 200000,
      maxOutputTokens: 64000,
      safeMaxInputTokens: 120000,
      actualInputTokens: 110,
      bufferTokens: 4000,
      utilizationPercentage: 0.1,
      overflowDetected: false,
      overflowAmount: 0,
      verbatimTurnsExcluded: 2,
    },
    messageTruncation: {
      wasTruncated: true,
      originalMessageCount: 30,
      truncatedMessageCount: 20,
      truncationMethod: 'token-budget',
      removedMessages: [{ role: 'user', tokens: 10, priority: 1 }],
    },
  },
  functionCalls: [
    {
      name: 'web_search',
      parameters: { query: 'weather' },
      returnValue: 'sunny',
      creditsUsed: 1,
      executionTime: 120,
      success: true,
      error: undefined,
      id: 'toolu_01',
    },
  ],
  performance: {
    totalResponseTime: 1000,
    contextRetrievalTime: 100,
    modelInferenceTime: 800,
    firstTokenTime: 200,
    clientFirstTokenTime: 250,
    streamingPerformance: { chunkCount: 10, totalStreamTime: 900, totalChars: 500, charsPerSecond: 555 },
    phases: { post_process: 10 },
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    agentName: 'Researcher',
  },
  prompt: 'hello',
  questId: 'quest-1',
  promptId: 'prompt-1',
  replyIds: ['r-1'],
  generatedImageReferences: ['img-1'],
  promptErrors: ['none'],
  warnings: ['a warning'],
  generatedAt: '2026-07-30T00:00:00.000Z',
  finishReason: 'end_turn',
  artifacts: [{ type: 'html', content: '<div />', metadata: { source: 'tool_result' }, timestamp: new Date() }],
  toolHealth: [
    {
      toolName: 'web_search',
      available: true,
      failureCount: 0,
      lastError: 'none',
      lastChecked: new Date(),
      lastExecutionTime: 120,
      successRate: 1,
    },
  ],
  executionTracking: {
    steps: [{ name: 'search', status: 'completed', startTime: new Date(), endTime: new Date(), result: 'ok' }],
    currentStep: 'search',
    completedSteps: ['search'],
    failedSteps: [],
  },
  humanReview: {
    required: false,
    approved: true,
    comments: 'fine',
    modifications: 'none',
    reviewedBy: 'user-1',
    reviewedAt: new Date(),
  },
  statusLog: [{ status: 'First model response', timestamp: new Date() }],
  citables: [{ id: 'c-1', type: 'web_url', title: 'A source', url: 'https://example.com' }],
  // contextTelemetry is deliberately absent. It is Mixed in Mongoose, so there is no subpath for
  // strict to strip, and the parity guard already covers it via the absorption rule. Mixed
  // round-tripping is exercised here by artifacts[].metadata and functionCalls[].parameters.
};

// Prompt and conversation content, deliberately never persisted. Present in the fixture so the
// negative control proves they are stripped rather than merely never written.
const EXCLUDED = {
  'context.systemPrompt': 'You are a helpful assistant.',
  'context.userPrompt': 'hello',
  'context.conversationContext': [{ role: 'user', content: 'earlier turn' }],
  'context.extraContextMessages': [{ role: 'system', content: 'a server-owned prompt' }],
};

/** Dotted leaf paths of a plain object, indexing into arrays so every element is checked. */
function leafPaths(value: unknown, prefix = '', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => leafPaths(entry, `${prefix}.${i}`, out));
    return out;
  }
  if (value instanceof Date || value === null || typeof value !== 'object') {
    if (prefix) out.push(prefix);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function readPath(source: unknown, path: string): unknown {
  // Array segments are numeric indices, so plain key access walks them without special casing.
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined) return undefined;
    return (node as Record<string, unknown>)[key];
  }, source);
}

/** Excluded paths are written without indices, so drop them before matching. */
const withoutIndices = (path: string) => path.replace(/\.\d+(?=\.|$)/g, '');

describe('QuestModel promptMeta persistence', () => {
  let mongoServer: MongoMemoryServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any; // any: the raw BSON document deliberately bypasses the Mongoose document type.

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await Quest.createIndexes();

    const quest = await Quest.create({
      sessionId: 'session-1',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hello',
    });

    await questRepository.update({
      id: quest.id,
      promptMeta: {
        ...FULL_PROMPT_META,
        context: {
          ...FULL_PROMPT_META.context,
          systemPrompt: EXCLUDED['context.systemPrompt'],
          userPrompt: EXCLUDED['context.userPrompt'],
          conversationContext: EXCLUDED['context.conversationContext'],
          extraContextMessages: EXCLUDED['context.extraContextMessages'],
          systemPromptSources: [{ ...FULL_PROMPT_META.context.systemPromptSources[0], content: 'prompt body' }],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, // any: the fixture carries excluded paths the PromptMeta type does not admit.
    });

    // Read the raw BSON. update() returns a hydrated document, and hydration re-applies strict,
    // so a stripped path and a declared-but-unwritten one are indistinguishable through it.
    raw = await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(quest.id) });
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it.each(leafPaths(FULL_PROMPT_META).filter(p => !(withoutIndices(p) in EXCLUDED)))('persists promptMeta.%s', path => {
    expect(readPath(raw.promptMeta, path)).toEqual(readPath(FULL_PROMPT_META, path));
  });

  it.each(Object.keys(EXCLUDED))('drops %s', path => {
    expect(readPath(raw.promptMeta, path)).toBeUndefined();
  });

  it('drops the content of every systemPromptSources entry', () => {
    const sources = (raw.promptMeta.context?.systemPromptSources ?? []) as Record<string, unknown>[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(source => source.content === undefined)).toBe(true);
  });

  it('survives the ingress parse that runs on every subsequent turn', () => {
    // ChatCompletionInvoke parses the stored promptMeta before each completion, so a persisted
    // value the Zod schema rejects fails the turn outright rather than losing telemetry.
    expect(() => PromptMetaZodSchema.parse(raw.promptMeta)).not.toThrow();
  });
});
