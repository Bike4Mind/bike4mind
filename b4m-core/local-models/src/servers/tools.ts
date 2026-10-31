import type { FetchLike, OpenAICompatibleProduct } from '../types';
import { replyRoom } from './contextBudget';

/** How an app words the hints: its name, and the tail that says when tools come back on. */
export interface HintApp {
  name: 'Desktop' | 'the CLI';
  recheck: string;
}

const PROPS_TIMEOUT_MS = 5_000;
/** Long enough for a busy server to produce the probe's one token. */
const TOOLS_PROBE_TIMEOUT_MS = 20_000;
const PROBE_TOOL = {
  type: 'function',
  function: { name: 'ping', description: 'Replies pong.', parameters: { type: 'object', properties: {} } },
};

/**
 * llama-server without --jinja (500), vLLM without --enable-auto-tool-choice (400, `"auto" tool choice requires
 * --enable-auto-tool-choice and --tool-call-parser to be set`), and some proxies refuse a request that declares tools.
 */
export function isToolRefusal(status: number, body: string): boolean {
  if (status !== 400 && status !== 500) return false;
  return /\btools?\b/i.test(body);
}

/** isToolRefusal on a response, reading the body only for a status a refusal can have. */
export async function refusesTools(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 500) return false;
  return isToolRefusal(response.status, await response.clone().text());
}

/**
 * Asks with a one-token request that declares a tool; null when the answer says nothing about tool support,
 * including when `signal` aborts it.
 */
export async function probeToolSupport(
  fetch: FetchLike,
  baseUrl: string,
  model: string,
  timeoutMs = TOOLS_PROBE_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<'accepted' | 'refused' | null> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        tools: [PROBE_TOOL],
      }),
    });
    if (response.ok) {
      await response.body?.cancel();
      return 'accepted';
    }
    if (await refusesTools(response)) return 'refused';
    await response.body?.cancel();
    return null;
  } catch {
    return null;
  }
}

/** llama-server's context from `/props`; undefined for other products or when it cannot be read. */
export async function serverContextTokens(
  fetch: FetchLike,
  baseUrl: string,
  product: OpenAICompatibleProduct | null,
  signal?: AbortSignal
): Promise<number | undefined> {
  if (product !== 'llama-server') return undefined;
  try {
    const timeout = AbortSignal.timeout(PROPS_TIMEOUT_MS);
    const response = await fetch(`${baseUrl}/props`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown };
    return tokenCount(body.default_generation_settings?.n_ctx) || tokenCount(body.n_ctx) || undefined;
  } catch {
    return undefined;
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Why tools are off and how to turn them on, for the server's settings row and the chat it happened in. */
export function toolsOffHint(label: string, product: OpenAICompatibleProduct | null, app: HintApp): string {
  if (product === 'vllm')
    return `${label} was started without tool calling, so its chats run without tools. Restart vLLM with --enable-auto-tool-choice and a --tool-call-parser for the model, ${app.recheck}`;
  if (product === 'llama-server')
    return `${label} refuses tool calls, so its chats run without tools. Restart llama-server with --jinja, ${app.recheck}`;
  return `${label} refuses tool calls, so its chats run without tools. Turn tool calling on there, ${app.recheck}`;
}

/** Why tools are off when the server's context is too small for the app's prompt and tools. */
export function contextTooSmallHint(
  label: string,
  product: OpenAICompatibleProduct | null,
  small: readonly { name: string; context: number }[],
  toolPromptTokens: number,
  app: HintApp
): string {
  const smallest = Math.min(...small.map(model => model.context));
  const names = small.map(model => model.name).join(', ');
  const sizes =
    new Set(small.map(model => model.context)).size === 1
      ? `a ${smallest}-token context`
      : `contexts as small as ${smallest} tokens`;
  return `${label} runs ${names} with ${sizes}, too small for ${app.name}'s instructions and tools (about ${toolPromptTokens} tokens), so its chats run without tools. ${restartWithContext(product, toolPromptTokens)}, ${app.recheck}`;
}

/** Why a turn cannot be sent at all: the context is too small for the prompt even without tools. */
export function promptTooLargeHint(
  label: string,
  product: OpenAICompatibleProduct | null,
  model: { name: string; context: number },
  promptTokens: number,
  app: HintApp
): string {
  return `${label} runs ${model.name} with a ${model.context}-token context, too small for ${app.name}'s instructions even without tools (about ${promptTokens} tokens). ${restartWithContext(product, promptTokens)}, ${app.recheck}`;
}

function restartWithContext(product: OpenAICompatibleProduct | null, promptTokens: number): string {
  const target = Math.max(16_384, 2 ** Math.ceil(Math.log2(promptTokens + replyRoom(16_384))));
  if (product === 'vllm') return `Restart vLLM with --max-model-len ${target}`;
  if (product === 'llama-server') return `Restart llama-server with --ctx-size ${target}`;
  return `Give it a context of ${target} tokens or more`;
}
