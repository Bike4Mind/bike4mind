/** Context sizing and history fitting for local Ollama chat requests. */
import { estimateFit, isCpuOnly, type FitInput, type HardwareProfile, type ModelArch } from '@bike4mind/common';
import { OUTPUT_RESERVE_TOKENS, replyRoom } from '@bike4mind/local-models/servers';
import { estimateTextTokens } from '@shared/contextLimit';
import { LOCAL_CONTEXT_SIZES, type LocalContextSetting } from '@shared/localContextSetting';

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
// CPU prefill runs at tens of tokens a second, so a larger window only costs RAM and load time;
// a conversation that needs more still grows past it.
export const CPU_ONLY_CONTEXT_CAP_TOKENS = 32_768;
const CHARS_PER_TOKEN = 4;
/** Ollama's own per-image figure when it fits chat history (ollama server/prompt.go). */
const IMAGE_TOKENS = 768;
const TEMPLATE_TOKENS_PER_MESSAGE = 4;
/** The summariser's instruction, the focus and the chat template around the transcript. */
const SUMMARY_OVERHEAD_TOKENS = 1_024;
// Code and non-English text run near 3 characters a token; English prose nearer 4.5.
const TRANSCRIPT_CHARS_PER_TOKEN = 3;
const RETRY_MARGIN = 0.9;

/** Granularity of the largest resident context growth searches for. */
const GROWTH_STEP_TOKENS = 4_096;
const MAX_LOCAL_CONTEXT = LOCAL_CONTEXT_SIZES[LOCAL_CONTEXT_SIZES.length - 1];
const LARGEST_FIRST = [...LOCAL_CONTEXT_SIZES].reverse();

/** What the Model Hub fit estimator needs to size a local model's context; any of it may be unknown. */
export interface LocalModelFootprint {
  arch: ModelArch | null;
  /** The model's files as Ollama lists them, projector included. */
  weightsBytes: number | null;
  hardware: HardwareProfile | null;
}

export interface ChatContextInput {
  setting: LocalContextSetting;
  footprint: LocalModelFootprint;
  /** The trained length Ollama reports, for a model whose arch Desktop cannot read. */
  modelLimit?: number;
  /** The Modelfile's num_ctx. */
  configured?: number;
}

type SizedInput = Omit<FitInput, 'context'>;

function fitInput({ arch, weightsBytes, hardware }: LocalModelFootprint): SizedInput | null {
  if (!arch || !weightsBytes || !hardware?.totalMemoryBytes) return null;
  // Ollama's cache type, flash attention and num_parallel are daemon settings its API does not report, so
  // this assumes the defaults; flash attention off or num_parallel above 1 makes the real footprint larger.
  return { model: { arch, weightsBytes }, hardware, mode: 'chat', runtime: { kind: 'ollama' } };
}

function trainedLimit(footprint: LocalModelFootprint, modelLimit: number | undefined): number | undefined {
  const limits = [footprint.arch?.contextMax, modelLimit].filter((n): n is number => n !== undefined);
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

function plan(input: SizedInput, context: number) {
  if (!Number.isInteger(context) || context < 1 || context > input.model.arch.contextMax) return undefined;
  return estimateFit({ ...input, context }).requested;
}

/** Entirely on the GPU, or in RAM on a machine without one: no layers offloaded. */
function resident(input: SizedInput, context: number): boolean {
  const requested = plan(input, context);
  return !!requested?.fits && (requested.placement === 'gpu' || requested.placement === 'cpu');
}

/**
 * Auto: the trained length or the largest Settings size that stays resident, at most 32K without a GPU,
 * else (or unmeasured) 16K; a larger resident Modelfile num_ctx within those bounds wins.
 * Fixed: the Settings size. Never past the trained length.
 */
export function chatContextTokens({ setting, footprint, modelLimit, configured }: ChatContextInput): number {
  const limit = trainedLimit(footprint, modelLimit);
  const cap = (tokens: number) => (limit === undefined ? tokens : Math.min(tokens, limit));
  if (setting.mode === 'fixed') return cap(setting.tokens);
  const floor = cap(LOCAL_CONTEXT_TARGET_TOKENS);
  const input = fitInput(footprint);
  if (!input || footprint.hardware?.confidence === 'low') return floor;
  const ceiling = isCpuOnly(input.hardware) ? CPU_ONLY_CONTEXT_CAP_TOKENS : Infinity;
  const allowed = (tokens: number) => tokens === cap(tokens) && tokens <= ceiling && resident(input, tokens);
  const picked = [cap(MAX_LOCAL_CONTEXT), ...LARGEST_FIRST].find(allowed) ?? floor;
  return configured !== undefined && configured > picked && allowed(configured) ? configured : picked;
}

/** Whether the model runs entirely on the GPU (or in RAM without one) at this context; undefined when unmeasurable. */
export function fitsInMemory(footprint: LocalModelFootprint, context: number): boolean | undefined {
  const input = fitInput(footprint);
  return input ? resident(input, context) : undefined;
}

/** Whether the model loads at all at this context, layers moved to system RAM included. */
export function loadsInMemory(footprint: LocalModelFootprint, context: number): boolean | undefined {
  const input = fitInput(footprint);
  return input ? plan(input, context)?.fits === true : undefined;
}

export type ContextGrowth =
  { tokens: number; slower: boolean } | { tokens?: undefined; reason: 'model-limit' | 'memory' | 'unmeasured' };

/**
 * Where Auto takes a model whose prompt needs `measured` tokens: once, to the largest resident context,
 * which without a GPU stops at 32K or the smallest Settings size that holds the prompt. Without a resident
 * size, or with an unmeasured GPU, that smallest Settings size; slower if offloaded.
 */
export function grownContext(
  footprint: LocalModelFootprint,
  measured: number,
  maxTokens: number | undefined,
  modelLimit: number | undefined,
  current: number
): ContextGrowth {
  const reply = maxTokens ?? OUTPUT_RESERVE_TOKENS;
  const holds = (context: number) => context - Math.min(reply, Math.floor(context / 4)) >= measured;
  const ceiling = Math.min(trainedLimit(footprint, modelLimit) ?? MAX_LOCAL_CONTEXT, MAX_LOCAL_CONTEXT);
  const sizes: number[] = [];
  for (let size = GROWTH_STEP_TOKENS; size < ceiling; size += GROWTH_STEP_TOKENS) if (holds(size)) sizes.push(size);
  sizes.push(ceiling);
  const needed = sizes[0];
  if (!holds(needed) || needed <= current) return { reason: 'model-limit' };
  const input = fitInput(footprint);
  if (!input) return { reason: 'unmeasured' };
  const preset = LOCAL_CONTEXT_SIZES.find(size => size >= needed && size <= ceiling);
  const steps = [preset, needed].filter((size): size is number => size !== undefined);
  if (footprint.hardware?.confidence !== 'low') {
    const reach = isCpuOnly(input.hardware) ? Math.max(CPU_ONLY_CONTEXT_CAP_TOKENS, preset ?? ceiling) : ceiling;
    // Memory only rises with context, so the resident sizes are a prefix of the list.
    let low = 0;
    let high = sizes.filter(size => size <= reach).length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (resident(input, sizes[middle])) low = middle + 1;
      else high = middle;
    }
    if (low > 0) return { tokens: sizes[low - 1], slower: false };
  }
  const step = steps.find(size => plan(input, size)?.fits);
  return step === undefined ? { reason: 'memory' } : { tokens: step, slower: !resident(input, step) };
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
  const budget = numCtx - replyRoom(numCtx, maxTokens);
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
