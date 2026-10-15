import type { IMessage } from '@bike4mind/common';

/**
 * Observation recorded for a tool call that has no result in the transcript (the run threw or was
 * cut between the call and its result). Providers reject a tool call left unanswered.
 */
export const MISSING_TOOL_RESULT = 'Tool call did not return a result.';

/** A tool call as the transcript records it. */
export type TranscriptToolCall = { id: string; name: string };

/**
 * Builds the backend's own message(s) carrying `observation` as the result of `call`. ReActAgent
 * derives it from `pushToolMessages`, so the result shape stays owned by the backend.
 */
export type ToolResultBuilder = (call: TranscriptToolCall, observation: string) => IMessage[];

export type TranscriptRepairReport = {
  synthesizedResults: number;
  movedResults: number;
  /** Results whose call is not in the transcript, and second results for an already-answered call. */
  droppedResults: number;
  replacedArguments: number;
};

/**
 * Wire shapes, by backend:
 * - Anthropic-style blocks: assistant `content[]` with `tool_use{id}`, results as `tool_result{tool_use_id}`
 *   blocks in a following user (or Gemini: `tool`) message.
 * - OpenAI-style: assistant `tool_calls[{id, function:{name, arguments}}]`, results as `role:'tool'`
 *   messages with `tool_call_id`.
 * Calls without an id (Ollama) cannot be paired and are left alone.
 */
type OpenAiToolCall = { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
type LooseMessage = IMessage & { tool_calls?: OpenAiToolCall[]; tool_call_id?: unknown };
type ContentBlock = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown };

const blocksOf = (message: IMessage): ContentBlock[] =>
  Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toolCallsOf(message: IMessage): TranscriptToolCall[] {
  if (message.role !== 'assistant') return [];
  const calls: TranscriptToolCall[] = [];
  for (const block of blocksOf(message)) {
    if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
      calls.push({ id: block.id, name: String(block.name ?? '') });
    }
  }
  for (const call of (message as LooseMessage).tool_calls ?? []) {
    if (typeof call?.id === 'string' && call.id) {
      calls.push({ id: call.id, name: String(call.function?.name ?? '') });
    }
  }
  return calls;
}

/**
 * The result ids a message carries, when it carries nothing else. Only these pure carriers are moved
 * or dropped; a message mixing results with other content is left where it is.
 */
function resultIdsOf(message: IMessage): string[] | null {
  const loose = message as LooseMessage;
  if (message.role === 'tool' && typeof loose.tool_call_id === 'string') return [loose.tool_call_id];
  const blocks = blocksOf(message);
  if (blocks.length === 0 || !blocks.every(block => block.type === 'tool_result')) return null;
  const ids = blocks.map(block => block.tool_use_id);
  return ids.every((id): id is string => typeof id === 'string') ? ids : null;
}

export function isJsonObjectString(value: string): boolean {
  try {
    return isPlainObject(JSON.parse(value));
  } catch {
    return false;
  }
}

// Messages whose arguments were already checked, so a long run does not re-parse every call's
// arguments on every request. A repaired message is a new object and is checked once in turn.
const hasValidArguments = new WeakSet<IMessage>();

/** Returns a copy with malformed tool-call arguments replaced by `{}`, or null if none were malformed. */
function withValidArguments(message: IMessage): { message: IMessage; replaced: number } | null {
  if (message.role !== 'assistant' || hasValidArguments.has(message)) return null;
  let replaced = 0;

  const blocks = blocksOf(message);
  const fixedBlocks = blocks.map(block => {
    if (block.type !== 'tool_use' || isPlainObject(block.input)) return block;
    replaced++;
    return { ...block, input: {} };
  });

  const toolCalls = (message as LooseMessage).tool_calls;
  const fixedToolCalls = toolCalls?.map(call => {
    const args = call?.function?.arguments;
    // Ollama sends arguments as an object; only a string that is not a JSON object is malformed.
    if (typeof args !== 'string' || isJsonObjectString(args)) return call;
    replaced++;
    return { ...call, function: { ...call.function, arguments: '{}' } };
  });

  if (replaced === 0) {
    hasValidArguments.add(message);
    return null;
  }
  const fixed: LooseMessage = { ...message };
  if (blocks.length > 0) fixed.content = fixedBlocks as IMessage['content'];
  if (fixedToolCalls) fixed.tool_calls = fixedToolCalls;
  return { message: fixed, replaced };
}

/**
 * Makes the transcript valid to send, in place, before every model request:
 * - each tool call is followed by its result: a result found elsewhere is moved up behind its call, a
 *   missing one is synthesized (`MISSING_TOOL_RESULT`) through `buildResult`;
 * - a result whose call is nowhere in the transcript, or a second result for a call, is dropped;
 * - tool-call arguments that are not a JSON object are replaced by `{}`.
 *
 * A valid transcript is left untouched (same array contents, same message objects), so on the normal
 * path, where backends append each call and its result as a pair, repair changes no request bytes.
 * A call id that appears in two assistant messages is answered once, after the first.
 * A result inside a mixed (non-pure) message answers its call even if it precedes it, so that call is
 * neither synthesized nor moved.
 */
export function repairTranscript(messages: IMessage[], buildResult: ToolResultBuilder): TranscriptRepairReport {
  const report: TranscriptRepairReport = {
    synthesizedResults: 0,
    movedResults: 0,
    droppedResults: 0,
    replacedArguments: 0,
  };

  const callIds = new Set(messages.flatMap(message => toolCallsOf(message).map(call => call.id)));
  // A result inside a message that also carries other content is never moved, so it answers its call
  // wherever it sits.
  const answered = new Set<string>();
  for (const message of messages) {
    if (resultIdsOf(message)) continue;
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') answered.add(block.tool_use_id);
    }
  }
  // Each answerable result id is owned by the first pure carrier holding it; every other copy is dropped.
  const ownerByResultId = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const id of resultIdsOf(message) ?? []) {
      if (callIds.has(id) && !answered.has(id) && !ownerByResultId.has(id)) ownerByResultId.set(id, index);
    }
  });
  const ownedIds = (index: number) =>
    [...new Set(resultIdsOf(messages[index]) ?? [])].filter(id => ownerByResultId.get(id) === index);

  const repaired: IMessage[] = [];

  messages.forEach((message, index) => {
    const resultIds = resultIdsOf(message);
    if (resultIds) {
      // Owned results are placed behind their call, which may come later; the rest are dropped.
      report.droppedResults += resultIds.length - ownedIds(index).length;
      return;
    }

    const argumentFix = withValidArguments(message);
    if (argumentFix) report.replacedArguments += argumentFix.replaced;
    repaired.push(argumentFix?.message ?? message);

    let expectedCarrierIndex = index + 1;
    const calls = toolCallsOf(message);
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      const carrierIndex = ownerByResultId.get(call.id);
      if (carrierIndex === undefined) {
        answered.add(call.id);
        const synthesized = buildResult(call, MISSING_TOOL_RESULT);
        if (synthesized.length === 0) continue;
        report.synthesizedResults++;
        repaired.push(...synthesized);
        continue;
      }
      // Only this message's results go here; a carrier answering calls of a later message is split.
      const ids = [...new Set(calls.map(c => c.id))].filter(
        id => !answered.has(id) && ownerByResultId.get(id) === carrierIndex
      );
      for (const id of ids) answered.add(id);
      if (carrierIndex === expectedCarrierIndex && ids.length === ownedIds(carrierIndex).length) expectedCarrierIndex++;
      else report.movedResults++;
      repaired.push(withOnlyResults(messages[carrierIndex], ids));
    }
  });

  if (isRepaired(report)) messages.splice(0, messages.length, ...repaired);
  return report;
}

/** The carrier with only the first result block for each of `ids`. */
function withOnlyResults(carrier: IMessage, ids: string[]): IMessage {
  const blocks = blocksOf(carrier);
  const remaining = new Set(ids);
  const kept = blocks.filter(block => remaining.delete(block.tool_use_id as string));
  if (kept.length === blocks.length) return carrier;
  return { ...carrier, content: kept as IMessage['content'] };
}

export function isRepaired(report: TranscriptRepairReport): boolean {
  return report.synthesizedResults + report.movedResults + report.droppedResults + report.replacedArguments > 0;
}
