import { normalize } from 'node:path';
import type { ChatMessage, ChatToolCall } from '@shared/chat';

/**
 * Which old tool results to replace with a placeholder on the wire.
 *
 * Every round re-sends the whole conversation and reads it back from the prompt cache, so a
 * stale file_read costs a cache read on every round after it. But changing an earlier message
 * invalidates the cache from that point on, and the next request re-writes everything after it
 * at 1.25x input instead of reading it at 0.1x. So clears are sticky (`ChatToolCall.cleared`)
 * and batched: nothing changes until the stale-but-uncleared results are worth one rewrite.
 */

/** Tool calls in the order they ran, grouped by the round that asked for them. */
export type ToolRounds = readonly (readonly ChatToolCall[])[];

export interface PruningPolicy {
  /** A batch smaller than this is not worth breaking the cache for, however cheap the rewrite. */
  minChars: number;
  /**
   * The pending stale characters, as a share of everything on the wire from the earliest of them
   * on. That tail is what the batch makes the provider re-write.
   */
  minShare: number;
  /** The most recent rounds that ran tools, which are never cleared. */
  exemptRounds: number;
}

/**
 * With cache writes at 1.25x and reads at 0.1x, clearing C characters out of a tail of S costs
 * about 1.25(S - C) - 0.1S once and saves 0.1C on every later round. At C = S/3 that repays in
 * about 22 rounds of the same turn; the next turn, which re-writes the previous turn's part of
 * the wire anyway, saves another 1.25C, so across the session it repays in about 10. A lower
 * share fires on tails where a 190K-token turn would never earn the rewrite back.
 * 40K characters (about 10K tokens) keeps short conversations from churning the cache at all.
 */
export const DEFAULT_PRUNING_POLICY: PruningPolicy = {
  minChars: 40_000,
  minShare: 1 / 3,
  exemptRounds: 2,
};

/**
 * Whole-file rewrites only. A file_edit leaves the read mostly true and its own result shows the
 * edited region, so clearing the read would just make the model read the file again.
 */
const REWRITE_TOOLS = new Set(['file_write']);

interface LineRange {
  first: number;
  last: number;
}

const WHOLE_FILE: LineRange = { first: 1, last: Number.POSITIVE_INFINITY };

export interface StaleScan {
  /** Empty unless this round's batch fires; then every stale result not already cleared. */
  clearIds: string[];
  /** Characters in stale results not yet cleared, whether or not the batch fired. */
  pendingChars: number;
}

export function findStaleResults(rounds: ToolRounds, policy: PruningPolicy = DEFAULT_PRUNING_POLICY): StaleScan {
  const nonEmpty = rounds.filter(round => round.length > 0);
  const eligible = Math.max(0, nonEmpty.length - policy.exemptRounds);

  const stale: { round: number; index: number; call: ChatToolCall }[] = [];
  for (let round = 0; round < eligible; round++) {
    nonEmpty[round].forEach((call, index) => {
      if (!call.cleared && isStale(call, nonEmpty.slice(round + 1))) stale.push({ round, index, call });
    });
  }
  const pendingChars = stale.reduce((sum, entry) => sum + resultChars(entry.call), 0);
  if (stale.length === 0 || pendingChars < policy.minChars) return { clearIds: [], pendingChars };

  const earliest = stale[0];
  let tailChars = 0;
  nonEmpty.forEach((round, roundIndex) =>
    round.forEach((call, index) => {
      if (roundIndex > earliest.round || (roundIndex === earliest.round && index >= earliest.index)) {
        tailChars += wireChars(call);
      }
    })
  );
  if (pendingChars < tailChars * policy.minShare) return { clearIds: [], pendingChars };

  return { clearIds: stale.map(entry => entry.call.id), pendingChars };
}

/** What the model is sent for this call's result. */
export function toolResultContent(call: ChatToolCall): string {
  if (call.error) return call.error;
  if (call.cleared) return stalePlaceholder(call);
  return call.preview ?? '';
}

export function stalePlaceholder(call: ChatToolCall): string {
  const path = typeof call.input.path === 'string' ? call.input.path : 'this file';
  const range = shownRange(call);
  const where = range && range !== WHOLE_FILE ? `${path} lines ${range.first}-${range.last}` : path;
  return `[stale: ${where} was read here; the file was rewritten or re-read later. Read it again if you need it.]`;
}

/**
 * A stored reply's calls, split back into the rounds that made them. A reply stored before rounds
 * were recorded is one round.
 */
export function historyRounds(messages: readonly ChatMessage[]): ChatToolCall[][] {
  const rounds: ChatToolCall[][] = [];
  for (const message of messages) {
    const calls = message.toolCalls ?? [];
    if (calls.length === 0) continue;
    rounds.push(
      ...splitRounds(
        calls,
        message.rounds?.map(round => round.toolCallIds)
      )
    );
  }
  return rounds;
}

function splitRounds(calls: readonly ChatToolCall[], roundIds?: readonly (readonly string[])[]): ChatToolCall[][] {
  if (!roundIds) return [[...calls]];
  const byId = new Map(calls.map(call => [call.id, call]));
  const placed = new Set<string>();
  const rounds = roundIds.map(ids =>
    ids.flatMap(id => {
      const call = byId.get(id);
      if (!call || placed.has(id)) return [];
      placed.add(id);
      return [call];
    })
  );
  const stray = calls.filter(call => !placed.has(call.id));
  if (stray.length > 0) rounds.push(stray);
  return rounds.filter(round => round.length > 0);
}

function isStale(call: ChatToolCall, later: ToolRounds): boolean {
  if (call.name !== 'file_read' || !succeeded(call)) return false;
  const path = pathOf(call);
  if (!path) return false;
  const range = shownRange(call);

  return later.some(round =>
    round.some(next => {
      if (!succeeded(next) || pathOf(next) !== path) return false;
      if (REWRITE_TOOLS.has(next.name)) return true;
      if (next.name !== 'file_read' || !range) return false;
      const covers = shownRange(next);
      return !!covers && covers.first <= range.first && covers.last >= range.last;
    })
  );
}

function succeeded(call: ChatToolCall): boolean {
  return call.status === 'done' && !call.error;
}

function pathOf(call: ChatToolCall): string | null {
  const path = call.input.path;
  return typeof path === 'string' && path.length > 0 ? normalize(path).replace(/(.)\/+$/, '$1') : null;
}

/**
 * The lines a file_read actually returned, from its own result: the output budget can stop a
 * read short of the range it asked for, so the arguments alone overstate what it covers. Null
 * for a result that shows no lines (binary, empty, offset past the end).
 */
function shownRange(call: ChatToolCall): LineRange | null {
  const text = call.preview ?? '';
  const trailer = /\[Lines (\d+)-(\d+) of \d+\.(?: Continue with offset \d+\.[^\]]*)?\]$/.exec(text);
  if (trailer) return { first: Number(trailer[1]), last: Number(trailer[2]) };
  return /^ *1\t/.test(text) ? WHOLE_FILE : null;
}

function resultChars(call: ChatToolCall): number {
  return toolResultContent(call).length;
}

function wireChars(call: ChatToolCall): number {
  return resultChars(call) + JSON.stringify(call.input).length;
}
