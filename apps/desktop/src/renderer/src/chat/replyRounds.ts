import type { ChatMessage, ChatReplyRound, ChatToolCall } from '@shared/chat';

/**
 * The turn as an ordered list of rounds to draw, however it was stored.
 *
 * A message from before rounds were recorded - or one whose turn ran no tools - collapses to a
 * single round holding everything, which is exactly how it used to draw: all the prose, then
 * all the rows. The ordering was never captured for those, and inventing one would put tool
 * rows next to text they have nothing to do with.
 */
export function roundsOf(message: ChatMessage): ChatReplyRound[] {
  if (!message.rounds || message.rounds.length === 0) {
    return [{ text: message.content, toolCallIds: (message.toolCalls ?? []).map(call => call.id) }];
  }

  const drawn: ChatReplyRound[] = [];
  for (const round of message.rounds) {
    const open = drawn[drawn.length - 1];
    // A round that said nothing is not a break in the narrative, so its calls join the round
    // whose prose introduced them. Twelve wordless commands in twelve rounds are one "Ran 12
    // commands" here, as they already are while the turn streams - and drawing a round apiece
    // would break the run up and defeat that collapsing on every reload.
    if (open !== undefined && wordless(round)) {
      drawn[drawn.length - 1] = { ...open, toolCallIds: [...open.toolCallIds, ...round.toolCallIds] };
      continue;
    }
    drawn.push(round);
  }
  // A leading round with neither prose nor calls carries only reasoning, which is no longer
  // drawn - and it is the shape a turn holds for as long as the model reasons before saying
  // anything. Left in, it would open every such reply with an empty round's worth of space.
  return drawn.filter(round => !wordless(round) || round.toolCallIds.length > 0);
}

/**
 * A round is wordless when its text is whitespace, not only when it is empty.
 *
 * A stored round was trimmed on its way to the store; a live one is rebuilt from the deltas and
 * keeps whatever the model ended on, which is routinely a stray newline. Testing for an empty
 * string sorted the same round one way while it streamed and the other way once it settled, so
 * the rows rearranged under the reader the moment the turn finished.
 */
function wordless(round: ChatReplyRound): boolean {
  return round.text.trim().length === 0;
}

/** A round's own calls, in the message's order. Ids it names that are gone simply drop out. */
export function callsIn(round: ChatReplyRound, toolCalls: readonly ChatToolCall[]): ChatToolCall[] {
  const wanted = new Set(round.toolCallIds);
  return toolCalls.filter(call => wanted.has(call.id));
}
