import { z } from 'zod';
import type { DecisionModelId, RawDecisionAnswer } from '@bike4mind/common';
import { readJson } from '../../videoProviders/http';
import { classifyStatus, parseRetryAfterMs, postJson } from '../http';
import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionProviderContext,
  type DecisionProviderRequest,
  type ProviderDecision,
  type ResolvedDecisionInput,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com';

const ProbabilityEntrySchema = z.object({ value: z.union([z.string(), z.number()]), probability: z.number() });

// Loose: OpenAI adds fields (usage details, ids) freely; we read only what we normalize.
const OpenAiAnswerSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('predicate'), probability: z.number() }),
  z.looseObject({ type: z.literal('choice'), probabilities: z.array(ProbabilityEntrySchema) }),
  z.looseObject({ type: z.literal('score'), probabilities: z.array(ProbabilityEntrySchema) }),
  z.looseObject({ type: z.literal('refusal') }),
]);

const OpenAiDecisionResponseSchema = z.looseObject({
  model: z.string(),
  answers: z.array(OpenAiAnswerSchema),
  usage: z.looseObject({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

const OpenAiErrorSchema = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    code: z.string().nullish(),
    param: z.string().nullish(),
  }),
});

type OpenAiInputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };

// OpenAI has no structured-state part, so a `json` part is sent as its serialized text.
const toOpenAiInput = (input: ResolvedDecisionInput) => {
  if (typeof input === 'string') return input;
  const content = input.map((part): OpenAiInputContent => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'json') return { type: 'input_text', text: JSON.stringify(part.json) };
    return { type: 'input_image', image_url: part.dataUrl };
  });
  return [{ role: 'user', content }];
};

const toRawAnswer = (answer: z.infer<typeof OpenAiAnswerSchema>): RawDecisionAnswer => {
  switch (answer.type) {
    case 'predicate':
      return { type: 'predicate', probability: answer.probability };
    case 'choice':
      return {
        type: 'choice',
        probabilities: Object.fromEntries(
          answer.probabilities.map(({ value, probability }) => [String(value), probability])
        ),
      };
    case 'score':
      return {
        type: 'score',
        probabilities: Object.fromEntries(
          answer.probabilities.map(({ value, probability }) => [Number(value), probability])
        ),
      };
    case 'refusal':
      return { type: 'refusal' };
  }
};

const toProviderError = (response: Response, body: unknown): DecisionProviderError => {
  const parsed = OpenAiErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.error.message : `OpenAI decisions returned ${response.status}`;
  const code = parsed.success ? parsed.data.error.code : undefined;
  const details = {
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers),
    param: (parsed.success ? parsed.data.error.param : undefined) ?? undefined,
    raw: body,
  };
  const kind = classifyStatus(response.status);
  if (kind !== 'client_error') return new DecisionProviderError(kind, message, details);
  if (code === 'context_length_exceeded') return new DecisionProviderError('context_length', message, details);
  // An unknown model is catalog drift on our side, not something the caller can fix.
  if (code === 'model_not_found' || response.status === 404)
    return new DecisionProviderError('upstream', message, details);
  return new DecisionProviderError('invalid_request', message, details);
};

/** OpenAI's `POST /v1/decisions`. Our question shape is OpenAI's, so questions pass through unchanged. */
export class OpenAiDecisionProvider implements DecisionProvider {
  readonly id = 'openaiDecisions' as const;
  readonly models: readonly DecisionModelId[] = ['gpt-6-luna'];

  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {}

  async decide(request: DecisionProviderRequest, ctx: DecisionProviderContext): Promise<ProviderDecision> {
    const response = await postJson(
      `${this.baseUrl}/v1/decisions`,
      ctx.apiKey,
      {
        model: request.model,
        input: toOpenAiInput(request.input),
        questions: request.questions,
        ...(request.safetyIdentifier ? { safety_identifier: request.safetyIdentifier } : {}),
      },
      ctx.signal
    );
    const body = await readJson(response);
    if (!response.ok) throw toProviderError(response, body);

    const parsed = OpenAiDecisionResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DecisionProviderError('upstream', `unexpected OpenAI decisions response: ${parsed.error.message}`, {
        status: response.status,
      });
    }
    return {
      model: parsed.data.model,
      answers: parsed.data.answers.map(toRawAnswer),
      usage: { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens },
    };
  }
}
