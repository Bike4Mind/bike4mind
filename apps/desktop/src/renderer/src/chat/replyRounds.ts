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
    //
    // Its reasoning comes along rather than being dropped on the floor: what the model thought
    // before running those commands is the record of why it ran them, and the collapsing is a
    // decision about ROWS, not about what the turn is allowed to remember.
    if (open !== undefined && round.text.length === 0) {
      const thought = [open.reasoning, round.reasoning].filter(Boolean).join('\n\n');
      drawn[drawn.length - 1] = {
        ...open,
        toolCallIds: [...open.toolCallIds, ...round.toolCallIds],
        ...(thought ? { reasoning: thought } : {}),
      };
      continue;
    }
    drawn.push(round);
  }
  // A round with neither prose nor calls carries only reasoning, and is kept for the one row
  // that can show it - see ReasoningRow. It is also the shape a turn holds for as long as the
  // model reasons before saying anything, but the renderer folds no reasoning into a reply
  // while it streams, so an open turn never reaches here with one.
  return drawn.filter(round => round.text.length > 0 || round.toolCallIds.length > 0 || !!round.reasoning);
}

/** A round's own calls, in the message's order. Ids it names that are gone simply drop out. */
export function callsIn(round: ChatReplyRound, toolCalls: readonly ChatToolCall[]): ChatToolCall[] {
  const wanted = new Set(round.toolCallIds);
  return toolCalls.filter(call => wanted.has(call.id));
}
