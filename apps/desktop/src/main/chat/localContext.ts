/** Context sizing and history fitting for local Ollama chat requests. */
import { estimateFit, type FitInput, type HardwareProfile, type ModelArch } from '@bike4mind/common';
import { estimateTextTokens } from '@shared/contextLimit';

export interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
  images?: string[];
  /** Part of the turn before it (tool screenshots, notes on tool results); stripped before sending. */
  continuesTurn?: boolean;
}

/** Ollama refused the prompt as longer than num_ctx; `tokens` is the size it measured. */
export class ContextOverflowError extends Error {
  constructor(
    message: string,
    readonly tokens: number,
    readonly limit: number
  ) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

// Desktop's system prompt and tool schemas alone run 5k-12k tokens, past Ollama's 4k default;
// 16k fits them plus a conversation while a small model's KV cache stays well under 1 GB.
export const LOCAL_CONTEXT_TARGET_TOKENS = 16_384;
const OUTPUT_RESERVE_TOKENS = 2_048;
const CHARS_PER_TOKEN = 4;
/** Ollama's own per-image figure when it fits chat history (ollama server/prompt.go). */
const IMAGE_TOKENS = 768;
const TEMPLATE_TOKENS_PER_MESSAGE = 4;
/** The summariser's instruction, the focus and the chat template around the transcript. */
const SUMMARY_OVERHEAD_TOKENS = 1_024;
// Code and non-English text run near 3 characters a token; English prose nearer 4.5.
const TRANSCRIPT_CHARS_PER_TOKEN = 3;
const RETRY_MARGIN = 0.9;

/** A context grown for one long prompt is rounded up to this, so the next long prompt rarely reloads. */
const GROWTH_STEP_TOKENS = 4_096;

/**
 * The num_ctx for every request to a model; Ollama reloads the model whenever it changes.
 * `fromMemory` (memoryContextTokens) replaces the Modelfile's num_ctx, which can be the whole trained
 * length; neither goes below the target, which Desktop's own instructions need.
 */
export function localContextTokens(
  modelLimit: number | undefined,
  configured: number | undefined,
  fromMemory?: number
): number {
  const wanted = Math.max(fromMemory ?? configured ?? 0, LOCAL_CONTEXT_TARGET_TOKENS);
  return modelLimit === undefined ? wanted : Math.min(wanted, modelLimit);
}

/** What the Model Hub fit estimator needs to size a local model's context; any of it may be unknown. */
export interface LocalModelFootprint {
  arch: ModelArch | null;
  /** The model's files as Ollama lists them, projector included. */
  weightsBytes: number | null;
  hardware: HardwareProfile | null;
}

function fitInput({ arch, weightsBytes, hardware }: LocalModelFootprint): Omit<FitInput, 'context'> | null {
  if (!arch || !weightsBytes || !hardware?.totalMemoryBytes) return null;
  // Ollama's KV cache type and flash attention are daemon-wide settings Desktop cannot read, so the
  // estimate assumes its defaults; a quantized cache only makes the real footprint smaller.
  return { model: { arch, weightsBytes }, hardware, mode: 'chat', runtime: { kind: 'ollama' } };
}

/**
 * The largest context, up to the estimator's chat target and the model's trained length, that this
 * machine's memory holds for the model, or its smallest preset when nothing fits. Undefined when the
 * estimator cannot size the model.
 */
export function memoryContextTokens(footprint: LocalModelFootprint): number | undefined {
  const input = fitInput(footprint);
  return input ? estimateFit(input).context : undefined;
}

/** Undefined when the estimator cannot size the model. */
export function fitsInMemory(footprint: LocalModelFootprint, context: number): boolean | undefined {
  const input = fitInput(footprint);
  if (!input) return undefined;
  if (!Number.isInteger(context) || context < 1 || context > input.model.arch.contextMax) return false;
  return estimateFit({ ...input, context }).requested?.fits === true;
}

/**
 * The context a prompt Ollama measured at `measured` tokens needs, with the reply room fitToContext
 * reserves; undefined when the model's trained length cannot hold it.
 */
export function grownContextTokens(
  measured: number,
  maxTokens: number | undefined,
  modelLimit: number | undefined
): number | undefined {
  const reply = maxTokens ?? OUTPUT_RESERVE_TOKENS;
  const needed = Math.min(measured + reply, Math.ceil((measured * 4) / 3));
  const wanted = Math.ceil(needed / GROWTH_STEP_TOKENS) * GROWTH_STEP_TOKENS;
  const context = modelLimit === undefined ? wanted : Math.min(wanted, modelLimit);
  return context - Math.min(reply, Math.floor(context / 4)) >= measured ? context : undefined;
}

export function estimateTokens(messages: readonly OllamaMessage[], tools: readonly unknown[] = []): number {
  const toolChars = tools.length > 0 ? JSON.stringify(tools).length : 0;
  return Math.ceil(toolChars / CHARS_PER_TOKEN) + messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function messageTokens(message: OllamaMessage): number {
  const callChars = message.tool_calls ? JSON.stringify(message.tool_calls).length : 0;
  return (
    estimateTextTokens(message.content) +
    Math.ceil(callChars / CHARS_PER_TOKEN) +
    (message.images?.length ?? 0) * IMAGE_TOKENS +
    TEMPLATE_TOKENS_PER_MESSAGE
  );
}

export interface ContextFit {
  messages: OllamaMessage[];
  dropped: number;
  /** The dropped messages the user sees in the thread: prompts and replies, not tool results. */
  visible: number;
}

/**
 * Drops the oldest whole turns until the prompt plus room for the reply fits; system messages and
 * the latest turn always stay. `scale` corrects the estimate.
 */
export function fitToContext(
  messages: readonly OllamaMessage[],
  tools: readonly unknown[],
  numCtx: number,
  maxTokens?: number,
  scale = 1
): ContextFit {
  const budget = numCtx - Math.min(maxTokens ?? OUTPUT_RESERVE_TOKENS, Math.floor(numCtx / 4));
  const starts = turnStarts(messages);
  const first = messages.findIndex(message => message.role !== 'system');
  if (first === -1 || starts.length === 0) return { messages: [...messages], dropped: 0, visible: 0 };
  const cuts = [...(first < starts[0] ? [starts[0]] : []), ...starts.slice(1)];
  let total = scale * estimateTokens(messages, tools);
  let cut = first;
  for (const next of cuts) {
    if (total <= budget) break;
    for (let index = cut; index < next; index++)
      if (messages[index].role !== 'system') total -= scale * messageTokens(messages[index]);
    cut = next;
  }
  const kept = messages.filter((message, index) => index >= cut || message.role === 'system');
  return { messages: kept, dropped: messages.length - kept.length, visible: visibleCount(messages.slice(0, cut)) };
}

function isTurnStart(message: OllamaMessage): boolean {
  return message.role === 'user' && !message.continuesTurn;
}

function turnStarts(messages: readonly OllamaMessage[]): number[] {
  return messages.flatMap((message, index) => (isTurnStart(message) ? [index] : []));
}

/** One per prompt and one per reply, however many tool rounds the reply took. */
function visibleCount(messages: readonly OllamaMessage[]): number {
  let count = 0;
  let inReply = false;
  for (const message of messages) {
    if (isTurnStart(message)) {
      count++;
      inReply = false;
    } else if (message.role === 'assistant' && !inReply) {
      count++;
      inReply = true;
    }
  }
  return count;
}

/** Transcript characters a local summary request starts with; see shrunkTranscriptChars for a refusal. */
export function localTranscriptChars(numCtx: number, replyTokens: number): number {
  return Math.max(numCtx - replyTokens - SUMMARY_OVERHEAD_TOKENS, Math.floor(numCtx / 4)) * TRANSCRIPT_CHARS_PER_TOKEN;
}

/** The transcript length to retry with after Ollama measured `measured` tokens for `chars` of it. */
export function shrunkTranscriptChars(chars: number, measured: number, numCtx: number, replyTokens: number): number {
  return Math.floor((chars * Math.max(numCtx - replyTokens, Math.floor(numCtx / 4)) * RETRY_MARGIN) / measured);
}

/** The prompt size Ollama reports when it refuses a request longer than num_ctx. */
export function overflowTokens(error: string): number | undefined {
  const match = /request \((\d+) tokens\) exceeds the available context size/.exec(error);
  return match ? Number(match[1]) : undefined;
}
