import { z } from 'zod';
import {
  DecisionResponseSchema,
  ListDecisionModelsResponseSchema,
  type DecisionInput,
  type DecisionModel,
  type DecisionResponse,
  type DecisionUsage,
  type RefusalAnswer,
} from '../schemas/decisions';
import type { DecisionModelId } from './catalog';

/**
 * Typed client for `POST /api/v1/decisions`. Declare questions inline (or `as const`) and every answer is typed from
 * its question: `byName.team` narrows on `type` to a choice whose `choice` is the literal union of the declared values.
 * Any answer may be a refusal, so narrow before reading it.
 */

type Described = { readonly description?: string };
export type PredicateQuestionDefinition = {
  readonly type: 'predicate';
  readonly name: string;
  readonly instructions: string;
};
export type ChoiceQuestionDefinition = {
  readonly type: 'choice';
  readonly name: string;
  readonly instructions: string;
  readonly choices: readonly ({ readonly value: string } & Described)[];
};
export type ScoreQuestionDefinition = {
  readonly type: 'score';
  readonly name: string;
  readonly instructions: string;
  readonly levels: readonly ({ readonly label: string } & Described)[];
};
export type DecisionQuestionDefinition =
  PredicateQuestionDefinition | ChoiceQuestionDefinition | ScoreQuestionDefinition;

type TypedRefusal<Name extends string> = RefusalAnswer & { name: Name };

export type AnswerFor<Q extends DecisionQuestionDefinition> =
  | TypedRefusal<Q['name']>
  | (Q extends ChoiceQuestionDefinition
      ? {
          type: 'choice';
          name: Q['name'];
          choice: Q['choices'][number]['value'];
          probabilities: { value: Q['choices'][number]['value']; probability: number }[];
          confidence: number;
        }
      : Q extends ScoreQuestionDefinition
        ? {
            type: 'score';
            name: Q['name'];
            score: number;
            probabilities: { value: number; label: Q['levels'][number]['label']; probability: number }[];
            confidence: number;
          }
        : { type: 'predicate'; name: Q['name']; probability: number });

export type AnswersByName<Qs extends readonly DecisionQuestionDefinition[]> = {
  [Q in Qs[number] as Q['name']]: AnswerFor<Q>;
};

export type TypedDecision<Qs extends readonly DecisionQuestionDefinition[]> = {
  id: string;
  model: string;
  answers: AnswerFor<Qs[number]>[];
  byName: AnswersByName<Qs>;
  usage: DecisionUsage;
};

export type DecideParams<Qs extends readonly DecisionQuestionDefinition[]> = {
  // Catalog ids autocomplete; any string is accepted so a model added server-side needs no client upgrade.
  model: DecisionModelId | (string & {});
  input: DecisionInput;
  questions: Qs;
  safety_identifier?: string;
};

export type DecideManyResult<Qs extends readonly DecisionQuestionDefinition[]> =
  { ok: true; decision: TypedDecision<Qs> } | { ok: false; error: unknown };

export type DecisionsClientOptions = {
  /** Origin of the B4M deployment, e.g. `https://app.example.com`. */
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
};

export class DecisionsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string,
    readonly param?: string,
    /** From `Retry-After` on 429 and 503 `provider_overloaded`. */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'DecisionsApiError';
  }
}

// Loose on purpose: an error code added server-side later must not turn into a parse failure here.
const ErrorBodySchema = z.looseObject({
  error: z.string().optional(),
  errorCode: z.string().optional(),
  param: z.string().optional(),
});

const readErrorBody = async (response: Response): Promise<z.infer<typeof ErrorBodySchema>> => {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data : {};
};

const toApiError = async (response: Response): Promise<DecisionsApiError> => {
  const body = await readErrorBody(response);
  const retryAfter = Number(response.headers.get('retry-after'));
  return new DecisionsApiError(
    body.error ?? `Decisions request failed with ${response.status}`,
    response.status,
    body.errorCode,
    body.param,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
  );
};

/** A 2xx body that does not match the published schema is still a DecisionsApiError, never a raw ZodError. */
const parseSuccessBody = <T>(schema: z.ZodType<T>, status: number, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DecisionsApiError(`Unexpected decisions response: ${parsed.error.message}`, status, 'invalid_response');
  }
  return parsed.data;
};

const withByName = <Qs extends readonly DecisionQuestionDefinition[]>(
  response: DecisionResponse
): TypedDecision<Qs> => {
  // The server returns answers in question order with each question's name, so this cast is the contract itself.
  const answers = response.answers as AnswerFor<Qs[number]>[];
  return {
    id: response.id,
    model: response.model,
    answers,
    byName: Object.fromEntries(answers.map(answer => [answer.name, answer])) as AnswersByName<Qs>,
    usage: response.usage,
  };
};

export const createDecisionsClient = ({ baseUrl, apiKey, fetch: fetchImpl = fetch }: DecisionsClientOptions) => {
  const origin = baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

  const decide = async <const Qs extends readonly DecisionQuestionDefinition[]>(
    params: DecideParams<Qs>
  ): Promise<TypedDecision<Qs>> => {
    const response = await fetchImpl(`${origin}/api/v1/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    if (!response.ok) throw await toApiError(response);
    return withByName<Qs>(parseSuccessBody(DecisionResponseSchema, response.status, await response.json()));
  };

  /**
   * Client-side fan-out: one decision per input, at most `concurrency` in flight. Results keep input order, and one
   * failure does not discard the rest.
   */
  const decideMany = async <const Qs extends readonly DecisionQuestionDefinition[]>(
    inputs: readonly DecisionInput[],
    params: Omit<DecideParams<Qs>, 'input'>,
    { concurrency = 4 }: { concurrency?: number } = {}
  ): Promise<DecideManyResult<Qs>[]> => {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
    }
    const results: DecideManyResult<Qs>[] = new Array(inputs.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < inputs.length) {
        const index = next++;
        try {
          results[index] = { ok: true, decision: await decide<Qs>({ ...params, input: inputs[index] }) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    };
    const workerCount = Math.min(concurrency, inputs.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  };

  const listModels = async (): Promise<DecisionModel[]> => {
    const response = await fetchImpl(`${origin}/api/v1/decision-models`, { headers });
    if (!response.ok) throw await toApiError(response);
    return parseSuccessBody(ListDecisionModelsResponseSchema, response.status, await response.json()).models;
  };

  return { decide, decideMany, listModels };
};

export type DecisionsClient = ReturnType<typeof createDecisionsClient>;
