import { describe, expect, it } from 'vitest';
import { MAX_MODEL_ID_LENGTH, ModelIdSchema } from './modelId';
import { CompletionRequestSchema } from './cliCompletions';
import { DecisionsRequestSchema } from './decisions';
import { CreateVideoGenerationBodySchema } from './videoGenerations';
import { CreateMusicGenerationBodySchema } from './musicGenerations';
import { CreateAgentRequestSchema, GenerateAgentAvatarRequestSchema, UpdateAgentRequestSchema } from './agentPublic';
import { SimplifiedChatRequestSchema } from './chat';
import { ChatCompletionCreateInputSchema, OpenAIImageGenerationInput } from './openai';
import { CliCompletionRequestAction } from './actions';

const ids = (length: number) => 'm'.repeat(length);

describe('ModelIdSchema', () => {
  it('caps model ids at 256 characters', () => {
    expect(MAX_MODEL_ID_LENGTH).toBe(256);
    expect(ModelIdSchema.safeParse('').success).toBe(false);
    expect(ModelIdSchema.safeParse(ids(256)).success).toBe(true);
    expect(ModelIdSchema.safeParse(ids(257)).success).toBe(false);
  });
});

type Case = [
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } },
  build: (model: string) => unknown,
  field: string,
];

const cases: Case[] = [
  [
    'CompletionRequestSchema',
    CompletionRequestSchema,
    model => ({ model, messages: [{ role: 'user', content: 'hi' }] }),
    'model',
  ],
  [
    'DecisionsRequestSchema',
    DecisionsRequestSchema,
    model => ({
      model,
      input: 'hi',
      questions: [{ type: 'predicate', name: 'q', instructions: 'Is it?' }],
    }),
    'model',
  ],
  ['CreateVideoGenerationBodySchema', CreateVideoGenerationBodySchema, model => ({ model, prompt: 'p' }), 'model'],
  ['CreateMusicGenerationBodySchema', CreateMusicGenerationBodySchema, model => ({ model, prompt: 'p' }), 'model'],
  [
    'CreateAgentRequestSchema',
    CreateAgentRequestSchema,
    model => ({ name: 'a', preferred_model: model }),
    'preferred_model',
  ],
  ['UpdateAgentRequestSchema', UpdateAgentRequestSchema, model => ({ preferred_model: model }), 'preferred_model'],
  [
    'GenerateAgentAvatarRequestSchema',
    GenerateAgentAvatarRequestSchema,
    model => ({ image_model: model }),
    'image_model',
  ],
  ['SimplifiedChatRequestSchema', SimplifiedChatRequestSchema, model => ({ message: 'hi', model }), 'model'],
  ['ChatCompletionCreateInputSchema model', ChatCompletionCreateInputSchema, model => ({ model }), 'model'],
  [
    'ChatCompletionCreateInputSchema imageModel',
    ChatCompletionCreateInputSchema,
    model => ({ model: 'x', imageModel: model }),
    'imageModel',
  ],
  [
    'OpenAIImageGenerationInput local-image',
    OpenAIImageGenerationInput,
    model => ({ prompt: 'p', model: `local-image/${model.slice('local-image/'.length)}` }),
    'model',
  ],
  [
    'CliCompletionRequestAction',
    CliCompletionRequestAction,
    model => ({
      action: 'cli_completion_request',
      accessToken: 'token',
      requestId: '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f',
      model,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    'model',
  ],
];

describe.each(cases)('%s model bound', (_name, schema, build, field) => {
  it('accepts 256 characters', () => {
    expect(schema.safeParse(build(ids(256))).success).toBe(true);
  });

  it('rejects 257 characters on the model field', () => {
    const result = schema.safeParse(build(ids(257)));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(i => i.path[0])).toContain(field);
  });
});

describe('SimplifiedChatRequestSchema model', () => {
  it('keeps an empty or omitted model meaning "use the admin default"', () => {
    expect(SimplifiedChatRequestSchema.safeParse({ message: 'hi', model: '' }).success).toBe(true);
    expect(SimplifiedChatRequestSchema.safeParse({ message: 'hi' }).success).toBe(true);
  });
});
