import type { ModelDispatchProfile } from '@bike4mind/common';
import type { DispatchAnswer, DispatchProbeDeps, DispatchProbeResult, ProbedDispatchAnswer } from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Reasoning tokens count against this cap, so it is sized for a reasoning burst
 * on a trivial forced call rather than for cost. A reply that truncates anyway
 * reads as retryable rather than as a refusal to call the tool, and a retryable
 * outcome costs no attempt: runModelDiscovery charges PROBE_MAX_ATTEMPTS only
 * for a verdict about the model, so a model that truncates every run keeps its
 * lifetime budget instead of being excluded by one.
 */
const PROBE_MAX_TOKENS = 8_192;

const PROBE_TOOL_NAME = 'ping';
const PROBE_PROMPT = `Call the ${PROBE_TOOL_NAME} function.`;

/**
 * Namespace prediction for the token parameter, and ONLY a prediction: it names
 * the parameter the first call sends, and a 400 flips it. A namespace this does
 * not know is a NEW model, which is what the modern parameter is for.
 */
const LEGACY_MAX_TOKENS_NAMESPACES: readonly RegExp[] = [/^gpt-3/, /^gpt-4/, /^chatgpt-/];

/**
 * Transient or environmental, none of them a verdict about the model: 401 and
 * 403 are the deployment's credential, 408 and 429 are the upstream asking for
 * a retry. 422 is a semantic rejection of the request BODY rather than a
 * timeout, and stays here because the body is the probe's own - a gateway that
 * refuses the forced tool_choice has said nothing about what the model takes.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 422, 429]);

const isRetryableStatus = (status: number): boolean => RETRYABLE_STATUSES.has(status) || status >= 500;

type MaxTokensParam = ModelDispatchProfile['maxTokensParam'];

export function predictMaxTokensParam(modelId: string): MaxTokensParam {
  return LEGACY_MAX_TOKENS_NAMESPACES.some(namespace => namespace.test(modelId))
    ? 'max_tokens'
    : 'max_completion_tokens';
}

type ChatOutcome =
  /** 200 carrying a real tool_calls array: the chat transport is confirmed. */
  | 'tool-call'
  /** 200 with prose instead. Definitive against the chat transport, silent in production. */
  | 'no-tool-call'
  | 'tools-unsupported'
  | 'wrong-token-param'
  /** No such model, or a refusal that says nothing about either transport. */
  | 'gone'
  | 'retryable';

/**
 * Ask OpenAI which dispatch shape a model takes, by making the model answer.
 *
 * Forcing a named function is what makes the answer decisive: a compliant model
 * MUST emit `tool_calls`, so a 200 carrying prose is a definitive negative
 * rather than an ambiguous one. A chat-path failure is NOT evidence that
 * /v1/responses works, so the second call is made rather than inferred. A second
 * 400 about the token parameter ends the probe instead: there would be no
 * verified maxTokensParam to write alongside a responses transport.
 *
 * Returns no answer unless a call verified one. `toolTransport` has no "off"
 * member, so an unverified model is left exactly as it is.
 *
 * The two fields are verified separately, and the answer says which: only a 200
 * proves maxTokensParam. The route that reaches /v1/responses through a 400
 * makes one more chat call without tools to prove it, and carries
 * `maxTokensParamVerified: false` when that call cannot, so the write path
 * declines the guess (see planOne in catalogWrite.ts).
 */
export async function probeOpenAiDispatch(modelId: string, deps: DispatchProbeDeps): Promise<DispatchProbeResult> {
  let maxTokensParam = predictMaxTokensParam(modelId);
  let outcome = await callChat(modelId, maxTokensParam, deps);
  const flipped = outcome === 'wrong-token-param';
  if (flipped) {
    maxTokensParam = otherParam(maxTokensParam);
    outcome = await callChat(modelId, maxTokensParam, deps);
  }

  if (outcome === 'tool-call') {
    return { answer: answerFor('openai-chat', maxTokensParam, 'chat', true), retryable: false };
  }
  if (outcome === 'retryable') return { retryable: true };
  if (outcome === 'gone' || outcome === 'wrong-token-param') return { retryable: false };

  // The chat endpoint said no in one of the two ways that leave /v1/responses
  // open. maxTokensParam rides along either way: completeViaResponses sends
  // max_output_tokens, but the terminal no-tools turn of a responses-transport
  // model falls back to the chat path, which reads this field. Only the 200
  // ('no-tool-call') proves the parameter; the 400 was about something else
  // and left it untested, which the tool-free call below settles.
  const responses = await callResponses(modelId, deps);
  if (responses === 'retryable') return { retryable: true };
  if (responses !== 'function-call') return { retryable: false };
  if (outcome === 'no-tool-call') {
    return { answer: answerFor('openai-responses', maxTokensParam, 'responses', true), retryable: false };
  }

  // A model that calls functions on chat only with reasoning disabled 400s the
  // forced call above for a reason unrelated to the token parameter.
  let plain = await callChatPlain(modelId, maxTokensParam, deps);
  // A flip already made on a 400 naming the first parameter is not undone.
  if (plain === 'wrong-token-param' && !flipped) {
    maxTokensParam = otherParam(maxTokensParam);
    plain = await callChatPlain(modelId, maxTokensParam, deps);
  }
  if (plain === 'retryable') return { retryable: true };
  return {
    answer: answerFor('openai-responses', maxTokensParam, 'responses', plain === 'accepted'),
    retryable: false,
  };
}

const otherParam = (param: MaxTokensParam): MaxTokensParam =>
  param === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';

const answerFor = (
  adapterFamily: NonNullable<DispatchAnswer['adapterFamily']>,
  maxTokensParam: MaxTokensParam,
  toolTransport: ModelDispatchProfile['toolTransport'],
  maxTokensParamVerified: boolean
): ProbedDispatchAnswer => ({
  adapterFamily,
  dispatchProfile: { maxTokensParam, toolTransport },
  maxTokensParamVerified,
});

async function callChat(
  modelId: string,
  maxTokensParam: MaxTokensParam,
  deps: DispatchProbeDeps
): Promise<ChatOutcome> {
  const response = await post('/v1/chat/completions', deps, {
    model: modelId,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    tools: [
      {
        type: 'function',
        function: {
          name: PROBE_TOOL_NAME,
          description: 'Answer that you are reachable.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: PROBE_TOOL_NAME } },
    [maxTokensParam]: PROBE_MAX_TOKENS,
  });

  if (!response) return 'retryable';
  const body = parse(response.text);
  if (response.status === 200) {
    const choices = prop(body, 'choices');
    const choice = Array.isArray(choices) ? choices[0] : undefined;
    const toolCalls = prop(prop(choice, 'message'), 'tool_calls');
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return 'tool-call';
    // A reasoning model can spend the whole cap before emitting the call it was
    // forced to make, which says nothing about the transport.
    return prop(choice, 'finish_reason') === 'length' ? 'retryable' : 'no-tool-call';
  }
  if (response.status === 400) {
    if (complainsAbout(body, maxTokensParam)) return 'wrong-token-param';
    // Any other 400 is treated like a refused tool_choice: it is a statement
    // about this endpoint, and only the second call can speak for the other one.
    return 'tools-unsupported';
  }
  return isRetryableStatus(response.status) ? 'retryable' : 'gone';
}

/** Tool-free chat call whose only job is to prove the endpoint accepts `maxTokensParam`. */
async function callChatPlain(
  modelId: string,
  maxTokensParam: MaxTokensParam,
  deps: DispatchProbeDeps
): Promise<'accepted' | 'wrong-token-param' | 'refused' | 'retryable'> {
  const response = await post('/v1/chat/completions', deps, {
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    [maxTokensParam]: PROBE_MAX_TOKENS,
  });

  if (!response) return 'retryable';
  // Any 200 proves the parameter, including one the cap truncated.
  if (response.status === 200) return 'accepted';
  if (response.status === 400) {
    return complainsAbout(parse(response.text), maxTokensParam) ? 'wrong-token-param' : 'refused';
  }
  // Unlike the forced call, this body carries no tool_choice a gateway could refuse,
  // so a 422 is a verdict on the request rather than a reason to retry.
  if (response.status === 422) return 'refused';
  return isRetryableStatus(response.status) ? 'retryable' : 'refused';
}

/** 'function-call' only for a 200 carrying the output item openaiBackend reads. */
async function callResponses(
  modelId: string,
  deps: DispatchProbeDeps
): Promise<'function-call' | 'none' | 'retryable'> {
  const response = await post('/v1/responses', deps, {
    model: modelId,
    input: [{ role: 'user', content: PROBE_PROMPT }],
    tools: [
      {
        type: 'function',
        name: PROBE_TOOL_NAME,
        description: 'Answer that you are reachable.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    tool_choice: { type: 'function', name: PROBE_TOOL_NAME },
    max_output_tokens: PROBE_MAX_TOKENS,
    store: false,
  });

  if (!response) return 'retryable';
  if (response.status !== 200) return isRetryableStatus(response.status) ? 'retryable' : 'none';
  const body = parse(response.text);
  const output = prop(body, 'output');
  if (Array.isArray(output) && output.some(item => prop(item, 'type') === 'function_call')) return 'function-call';
  // Same truncation as the chat path: the cap ran out inside the reasoning.
  return prop(body, 'status') === 'incomplete' ? 'retryable' : 'none';
}

/** Undefined for a transport error or a timeout, which the caller reads as retryable. */
async function post(
  path: string,
  deps: DispatchProbeDeps,
  body: Record<string, unknown>
): Promise<{ status: number; text: string } | undefined> {
  try {
    const response = await deps.fetch(`${deps.baseUrl ?? DEFAULT_BASE_URL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: deps.signal
        ? AbortSignal.any([AbortSignal.timeout(deps.timeoutMs), deps.signal])
        : AbortSignal.timeout(deps.timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return undefined;
  }
}

/** Does this error body name `param` as the thing it will not accept? */
function complainsAbout(body: unknown, param: string): boolean {
  const error = prop(body, 'error');
  if (prop(error, 'param') === param) return true;
  const message = prop(error, 'message');
  return typeof message === 'string' && message.includes(param);
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const prop = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
