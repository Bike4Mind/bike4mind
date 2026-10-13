import { z } from 'zod';
import type { DecisionModelId, DecisionQuestion, RawDecisionAnswer } from '@bike4mind/common';
import { readJson } from '../../generationProviders/http';
import { classifyStatus, parseRetryAfterMs, postJson } from '../http';
import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionProviderContext,
  type DecisionProviderRequest,
  type ProviderDecision,
  type ResolvedDecisionInput,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

const ProbabilityMapSchema = z.record(z.string(), z.number());

// Loose: the vendor adds fields (legend, confidence) freely; we read only what we normalize. Its `confidence` is
// ignored because B4M computes one for every model from the probabilities.
const SystemOneAnswerSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('noul'), noul: z.number() }),
  z.looseObject({ type: z.literal('choice'), probabilities: ProbabilityMapSchema }),
  z.looseObject({ type: z.literal('score'), probabilities: ProbabilityMapSchema }),
]);
type SystemOneAnswer = z.infer<typeof SystemOneAnswerSchema>;

const SystemOneResponseSchema = z.looseObject({
  model: z.string(),
  answers: z.record(z.string(), SystemOneAnswerSchema),
  usage: z.looseObject({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

// Invalid requests come back as either `{ detail: { error_type, message } }` or `{ detail: string }`.
const SystemOneErrorSchema = z.looseObject({
  detail: z.union([z.string(), z.looseObject({ message: z.string() })]),
});

export const UNKNOWN_MODEL_PREFIX = 'Unknown model';

/** The vendor's own wording from either 400 envelope, or undefined when the body fits neither. */
export const readSystemOneErrorMessage = (body: unknown): string | undefined => {
  const parsed = SystemOneErrorSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const { detail } = parsed.data;
  return typeof detail === 'string' ? detail : detail.message;
};

type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

const toSystemOneQuestion = (question: DecisionQuestion): SystemOneQuestion => {
  switch (question.type) {
    case 'predicate':
      return { type: 'noul', instructions: question.instructions };
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(question.choices.map(({ value, description }) => [value, description ?? null])),
      };
    case 'score':
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.levels.map(({ label, description }) => description ?? label),
      };
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Jev documents state as a string, a JSON object, or an array of text values. Only a lone json object is sent as the
// state itself; any other json value (array, number, ...) would not be valid, so it travels serialized in the list.
const toState = (input: ResolvedDecisionInput): unknown => {
  if (typeof input === 'string') return input;
  const [only] = input;
  if (input.length === 1 && only.type === 'json' && isPlainObject(only.json)) return only.json;
  return input.map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'json') return JSON.stringify(part.json);
    throw new DecisionProviderError('invalid_request', 'TypeSafe models accept text only');
  });
};

const upstreamMismatch = (message: string): DecisionProviderError =>
  new DecisionProviderError('upstream', `unexpected TypeSafe response: ${message}`);

// Jev returns probability keys in arbitrary order, so they are read back by the request's own keys. A missing or extra
// key means the vendor answered a different question than we asked.
const readProbabilities = (
  name: string,
  probabilities: Readonly<Record<string, number>>,
  expectedKeys: readonly string[]
): number[] => {
  const received = Object.keys(probabilities);
  const missing = expectedKeys.filter(key => !Object.hasOwn(probabilities, key));
  if (missing.length > 0 || received.length !== expectedKeys.length) {
    throw upstreamMismatch(`answer ${name} has probability keys that do not match the question`);
  }
  return expectedKeys.map(key => probabilities[key]);
};

const toRawAnswer = (question: DecisionQuestion, answer: SystemOneAnswer | undefined): RawDecisionAnswer => {
  if (!answer) throw upstreamMismatch(`no answer for question ${question.name}`);
  const expectedType = question.type === 'predicate' ? 'noul' : question.type;
  if (answer.type !== expectedType) {
    throw upstreamMismatch(`answer ${question.name} is a ${answer.type}, expected ${expectedType}`);
  }
  if (answer.type === 'noul') return { type: 'predicate', probability: answer.noul };
  if (question.type === 'choice' && answer.type === 'choice') {
    const values = question.choices.map(choice => choice.value);
    const ordered = readProbabilities(question.name, answer.probabilities, values);
    return { type: 'choice', probabilities: Object.fromEntries(values.map((value, index) => [value, ordered[index]])) };
  }
  if (question.type === 'score' && answer.type === 'score') {
    const indices = question.levels.map((_level, index) => String(index));
    return { type: 'score', probabilities: { ...readProbabilities(question.name, answer.probabilities, indices) } };
  }
  throw upstreamMismatch(`answer ${question.name} does not fit its question`);
};

const toProviderError = (response: Response, body: unknown): DecisionProviderError => {
  const status = response.status;
  const details = { status, retryAfterMs: parseRetryAfterMs(response.headers), raw: body };
  const kind = classifyStatus(status);
  if (kind !== 'client_error') return new DecisionProviderError(kind, `TypeSafe returned ${status}`, details);
  const message = readSystemOneErrorMessage(body);
  // Jev reports an unknown model as a plain 400. Validation only admits catalog ids, so that is catalog drift on our
  // side, not something the caller can fix. The nightly contract probe pins this wording.
  if (message?.startsWith(UNKNOWN_MODEL_PREFIX)) {
    return new DecisionProviderError('upstream', 'TypeSafe does not recognize the model', details);
  }
  // Other 4xx mean a misrouted base URL or a vendor change, not a caller error.
  if (status !== 400 && status !== 422) {
    return new DecisionProviderError('upstream', `TypeSafe returned ${status}`, details);
  }
  // The vendor's wording describes its own wire format, not our caller's request, so it stays in `raw`.
  return new DecisionProviderError('invalid_request', 'The decision provider rejected the request.', {
    ...details,
    raw: { message, body },
  });
};

/** The wire body for one request; exported so the fixture recorder posts exactly what the adapter would. */
export const toSystemOneRequestBody = (request: DecisionProviderRequest) => ({
  model: request.model,
  state: toState(request.input),
  questions: Object.fromEntries(request.questions.map(question => [question.name, toSystemOneQuestion(question)])),
});

/** TypeSafe's `POST /v1/systemone` (Jev). Self-hosted deployments serve the same protocol at their own base URL. */
export class SystemOneDecisionProvider implements DecisionProvider {
  readonly id = 'systemOne' as const;
  readonly models: readonly DecisionModelId[] = ['jev-1.13.0', 'jev-latest'];

  constructor(private readonly baseUrl: string = DEFAULT_BASE_URL) {}

  async decide(request: DecisionProviderRequest, ctx: DecisionProviderContext): Promise<ProviderDecision> {
    const response = await postJson(
      `${this.baseUrl}/v1/systemone`,
      ctx.apiKey,
      toSystemOneRequestBody(request),
      ctx.signal
    );
    const body = await readJson(response);
    if (!response.ok) {
      const error = toProviderError(response, body);
      if (error.kind === 'invalid_request' || error.kind === 'upstream') {
        // Server-side only: the vendor message never reaches the caller and the request body is never logged.
        ctx.logger.warn('systemone_request_rejected', {
          status: response.status,
          message: readSystemOneErrorMessage(body),
        });
      }
      throw error;
    }

    const parsed = SystemOneResponseSchema.safeParse(body);
    if (!parsed.success) throw upstreamMismatch(parsed.error.message);
    const { answers, model, usage } = parsed.data;
    return {
      model,
      answers: request.questions.map(question =>
        toRawAnswer(question, Object.hasOwn(answers, question.name) ? answers[question.name] : undefined)
      ),
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    };
  }
}
