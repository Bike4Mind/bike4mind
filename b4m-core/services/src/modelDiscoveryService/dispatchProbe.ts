import type { ModelDispatchProfile } from '@bike4mind/common';
import type { DispatchAnswer, DispatchProbeDeps, DispatchProbeResult } from './types';

const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Reasoning tokens count against this cap, so it is sized for a reasoning burst
 * on a trivial forced call rather than for cost. A reply that truncates anyway
 * is retried, never read as a refusal to call the tool.
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

/** Transient or environmental. 408 and 422 are request timeouts, not verdicts about the model. */
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
 */
export async function probeOpenAiDispatch(modelId: string, deps: DispatchProbeDeps): Promise<DispatchProbeResult> {
  let maxTokensParam = predictMaxTokensParam(modelId);
  let outcome = await callChat(modelId, maxTokensParam, deps);
  if (outcome === 'wrong-token-param') {
    maxTokensParam = maxTokensParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    outcome = await callChat(modelId, maxTokensParam, deps);
  }

  if (outcome === 'tool-call') return { answer: answerFor('openai-chat', maxTokensParam, 'chat'), retryable: false };
  if (outcome === 'retryable') return { retryable: true };
  if (outcome === 'gone' || outcome === 'wrong-token-param') return { retryable: false };

  // The chat endpoint said no in one of the two ways that leave /v1/responses
  // open. maxTokensParam rides along either way: completeViaResponses sends
  // max_output_tokens, but the terminal no-tools turn of a responses-transport
  // model falls back to the chat path, which reads this field.
  const responses = await callResponses(modelId, deps);
  if (responses === 'retryable') return { retryable: true };
  return responses === 'function-call'
    ? { answer: answerFor('openai-responses', maxTokensParam, 'responses'), retryable: false }
    : { retryable: false };
}

const answerFor = (
  adapterFamily: NonNullable<DispatchAnswer['adapterFamily']>,
  maxTokensParam: MaxTokensParam,
  toolTransport: ModelDispatchProfile['toolTransport']
): DispatchAnswer => ({ adapterFamily, dispatchProfile: { maxTokensParam, toolTransport } });

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
